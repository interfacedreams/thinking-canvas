import { create } from 'zustand'
import { applyNodeChanges, type Node, type NodeChange, type Viewport } from '@xyflow/react'
import { DEFAULT_MODEL, MODEL_OPTIONS } from '../../../shared/types'
import type {
  CanvasDoc,
  FolderState,
  ForkRef,
  ModelId,
  NoteVersion,
  PermissionRequest,
  PersistedEdge,
  PersistedMessage,
  TurnUsage
} from '../../../shared/types'
import { nextColorId } from '../lib/palette'

export const NODE_W = 600
export const MAX_NODE_H = 1280
const MIN_GROW_H = 280
export const GAP = 24

/**
 * Tallest a node should auto-grow. Node heights live in flow coordinates; on
 * screen they render at height × zoom. Zoomed in (zoom > 1) the cap shrinks so
 * the node still fits the screen. Zoomed out it stays at the zoom-1 size: a
 * node sized to fill a zoomed-out screen is huge in flow px, and its text is
 * unreadably small whenever the whole node is in view.
 */
export function viewportFitHeight(zoom: number): number {
  const h = (window.innerHeight * 0.85) / Math.max(zoom, 1)
  return Math.round(Math.min(MAX_NODE_H, Math.max(MIN_GROW_H, h)))
}
// Placement estimate for a node whose content hasn't been measured yet.
const EST_NODE_H = 360

export type Message = PersistedMessage

export type ChatStatus = 'empty' | 'idle' | 'streaming'

export interface ChatData {
  title: string
  color?: string // palette id (see lib/palette); undefined renders as the default butter
  messages: Message[]
  status: ChatStatus
  draft: string
  minimized: boolean
  savedHeight?: number // explicit height to restore when un-minimizing
  growthCap?: number // auto-grow ceiling (flow px), sized to fit the screen at send time
  sessionId?: string // Agent SDK session; set after the first turn, used for resume
  forkOf?: ForkRef // pending fork; consumed by the first send, then cleared
  focusDraft?: boolean // autofocus the composer when the node mounts
  lastUsage?: TurnUsage // tokens/cost of the most recent turn
  pendingPermission?: PermissionRequest // tool call awaiting the user's Allow/Deny
  // Research children are display-only researcher transcripts: no composer,
  // no forking, no session of their own (they ran inside the lead's session).
  kind?: 'research'
  researchArmed?: boolean // composer toggle: the next send runs in research mode
  [key: string]: unknown
}

export interface NoteData {
  title: string
  color?: string
  content: string // live markdown, mirror of the note's title-named file
  versions: NoteVersion[]
  viewVersion?: number // runtime: index of the version being viewed; undefined = live
  status: 'idle' | 'streaming'
  draft: string // the AI-instruction composer
  lastReply?: string // the AI's brief commentary from its latest editing turn
  minimized: boolean
  savedHeight?: number
  growthCap?: number
  sessionId?: string
  focusDraft?: boolean // autofocus the content editor when the node mounts
  lastUsage?: TurnUsage
  pendingPermission?: PermissionRequest
  [key: string]: unknown
}

export type ChatNode = Node<ChatData, 'chat'>
export type NoteNode = Node<NoteData, 'note'>
export type CanvasNode = ChatNode | NoteNode

export const isChat = (n: CanvasNode): n is ChatNode => n.type === 'chat'
export const isNote = (n: CanvasNode): n is NoteNode => n.type === 'note'

interface Rect {
  x: number
  y: number
  w: number
  h: number
}

const uid = (): string => crypto.randomUUID()

function makeNode(position: { x: number; y: number }, partial?: Partial<ChatData>): ChatNode {
  return {
    id: uid(),
    type: 'chat',
    position,
    width: NODE_W,
    dragHandle: '.drag-handle',
    data: { title: '', messages: [], status: 'empty', draft: '', minimized: false, ...partial }
  }
}

function makeNoteNode(position: { x: number; y: number }, partial?: Partial<NoteData>): NoteNode {
  return {
    id: uid(),
    type: 'note',
    position,
    width: NODE_W,
    dragHandle: '.drag-handle',
    data: {
      title: '',
      content: '',
      versions: [],
      status: 'idle',
      draft: '',
      minimized: false,
      ...partial
    }
  }
}

function boxOf(n: CanvasNode): Rect {
  return {
    x: n.position.x,
    y: n.position.y,
    w: n.width ?? n.measured?.width ?? NODE_W,
    h: n.height ?? n.measured?.height ?? EST_NODE_H
  }
}

function intersects(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
}

/** Overlap test with the required clearance baked in. */
function tooClose(a: Rect, b: Rect): boolean {
  return intersects({ x: a.x - GAP, y: a.y - GAP, w: a.w + 2 * GAP, h: a.h + 2 * GAP }, b)
}

/** A node plus every chat forked from it, transitively (fork edges run source → target). */
export function forkSubtree(edges: PersistedEdge[], rootId: string): Set<string> {
  const ids = new Set([rootId])
  let grew = true
  while (grew) {
    grew = false
    for (const e of edges) {
      if (ids.has(e.source) && !ids.has(e.target)) {
        ids.add(e.target)
        grew = true
      }
    }
  }
  return ids
}

/**
 * Forks land to the right of their parent, stacking downward when occupied.
 * Forks sharing an anchor message queue up: each new one starts just beneath
 * the bottom-most existing sibling.
 */
function findForkSpot(
  nodes: CanvasNode[],
  parent: ChatNode,
  siblings: CanvasNode[]
): { x: number; y: number } {
  const boxes = nodes.map(boxOf)
  const p = boxOf(parent)
  const spot = { x: p.x + p.w + GAP, y: p.y }
  if (siblings.length > 0) {
    const lowest = siblings.map(boxOf).reduce((a, b) => (b.y + b.h > a.y + a.h ? b : a))
    spot.x = lowest.x
    spot.y = lowest.y + lowest.h + GAP
  }
  while (boxes.some((b) => tooClose({ ...spot, w: NODE_W, h: EST_NODE_H }, b))) {
    spot.y += EST_NODE_H + GAP
  }
  return spot
}

interface CanvasState {
  nodes: CanvasNode[]
  edges: PersistedEdge[]
  viewport: Viewport
  loaded: boolean
  folder: FolderState | null // null until the first folder:get answers
  model: ModelId // model for new turns; persisted app-wide in localStorage
  setModel: (model: ModelId) => void
  // Runtime-only: per node, the y-offset (flow px from the node top) of each
  // message that an edge anchors on — measured from the DOM by ChatNodeView so
  // fork edges can attach to the message itself rather than the node center.
  anchorOffsets: Record<string, Record<string, number>>
  setAnchorOffsets: (nodeId: string, offsets: Record<string, number>) => void
  // Runtime-only: node awaiting delete confirmation (the modal is open for it).
  pendingDeleteId: string | null
  // Runtime-only: a new-node ghost is stuck to the cursor, waiting for a
  // placement click on the canvas (armed by the toolbar buttons / C / N).
  placing: 'chat' | 'note' | null
  setPlacing: (kind: 'chat' | 'note' | null) => void
  requestDelete: (id: string) => void
  cancelDelete: () => void
  deleteChat: (id: string, cascade: boolean) => void
  init: () => Promise<Viewport | null>
  chooseFolder: () => Promise<Viewport | null>
  selectFolder: (path: string) => Promise<Viewport | null>
  onNodesChange: (changes: NodeChange<CanvasNode>[]) => void
  setViewport: (vp: Viewport) => void
  addNodeAt: (position: { x: number; y: number }) => ChatNode
  addNoteAt: (position: { x: number; y: number }) => NoteNode
  clearFocusDraft: (id: string) => void
  setDraft: (id: string, draft: string) => void
  setColor: (id: string, color: string) => void
  setTitle: (id: string, title: string) => void
  commitNoteTitle: (id: string) => Promise<void>
  setNoteContent: (id: string, content: string) => void
  setViewVersion: (id: string, index: number | undefined) => void
  restoreVersion: (id: string, index: number) => Promise<void>
  send: (id: string) => void
  sendNote: (id: string) => Promise<void>
  toggleResearch: (id: string) => void
  respondPermission: (id: string, requestId: string, allow: boolean) => void
  forkChat: (nodeId: string) => string | null
  discardNode: (id: string) => void
  toggleMinimize: (id: string) => void
  load: () => Promise<Viewport | null>
  persistSoon: () => void
  persistThread: (id: string) => void
}

// Model choice is an app-wide preference, not part of any one canvas —
// it lives in localStorage rather than canvas.json.
const MODEL_STORAGE_KEY = 'bee-claude:model'
function loadModel(): ModelId {
  const saved = localStorage.getItem(MODEL_STORAGE_KEY)
  return MODEL_OPTIONS.some((m) => m.id === saved) ? (saved as ModelId) : DEFAULT_MODEL
}

let saveTimer: ReturnType<typeof setTimeout> | undefined
// Debounced per-note autosave of live content (keystrokes → the note's file).
const noteSaveTimers = new Map<string, ReturnType<typeof setTimeout>>()
// Researchers streaming right now: `${leadNodeId}:${toolUseId}` → child node id.
// Mid-turn only, so it lives outside the store (no re-renders, never persisted).
const researchChildren = new Map<string, string>()

export const useCanvasStore = create<CanvasState>((set, get) => {
  const patchData = (id: string, patch: Record<string, unknown>): void => {
    set((s) => ({
      nodes: s.nodes.map((n) =>
        n.id === id ? ({ ...n, data: { ...n.data, ...patch } } as CanvasNode) : n
      )
    }))
  }

  const buildDoc = (): CanvasDoc => {
    const { nodes, edges, viewport } = get()
    return {
      version: 1,
      nodes: nodes.map((n) => {
        const height = n.data.minimized ? n.data.savedHeight : n.height
        return {
          id: n.id,
          ...(isNote(n)
            ? { kind: 'note' as const }
            : n.data.kind === 'research'
              ? { kind: 'research' as const }
              : {}),
          position: n.position,
          width: n.width ?? NODE_W,
          ...(height != null ? { height } : {}),
          title: n.data.title,
          ...(n.data.color ? { color: n.data.color } : {}),
          ...(n.data.minimized ? { minimized: true } : {}),
          ...(n.data.sessionId ? { sessionId: n.data.sessionId } : {}),
          ...(isChat(n) && n.data.forkOf ? { forkOf: n.data.forkOf } : {})
        }
      }),
      edges,
      viewport
    }
  }

  const persist = (): void => {
    if (!get().loaded) return
    clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      saveTimer = undefined
      void window.api.canvas.save(buildDoc())
    }, 500)
  }

  // Transcripts persist one file per node, written when a turn's messages
  // settle (user send, turn done) rather than on the debounced layout save.
  const persistThread = (id: string): void => {
    const node = get().nodes.find((n) => n.id === id)
    if (!node || !isChat(node)) return
    // Skip the still-empty assistant placeholder so a reload mid-turn
    // doesn't render a blank bubble.
    const messages = node.data.messages.filter((m) => m.role !== 'assistant' || m.text !== '')
    void window.api.canvas.saveThread(id, messages)
  }

  // Push a note's pending autosave through now — before an AI turn reads the
  // file from disk, and before switching folders.
  const flushNoteSave = async (id: string): Promise<void> => {
    const timer = noteSaveTimers.get(id)
    if (!timer) return
    clearTimeout(timer)
    noteSaveTimers.delete(id)
    const node = get().nodes.find((n) => n.id === id)
    if (node && isNote(node)) await window.api.note.save(id, node.data.content)
  }

  const flushNoteSaves = async (): Promise<void> => {
    await Promise.all([...noteSaveTimers.keys()].map(flushNoteSave))
  }

  // A debounced save writes to whichever folder is current in the main process —
  // flush it before switching so it can't land in the next folder's canvas.
  const flushSave = async (): Promise<void> => {
    await flushNoteSaves()
    if (saveTimer === undefined) return
    clearTimeout(saveTimer)
    saveTimer = undefined
    if (get().loaded) await window.api.canvas.save(buildDoc())
  }

  const switchFolder = async (next: FolderState | null): Promise<Viewport | null> => {
    if (!next) return null // dialog canceled
    if (next.current === get().folder?.current) {
      set({ folder: next }) // same folder re-picked — just refresh the recents order
      return null
    }
    set({ folder: next, nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 }, placing: null })
    const vp = await get().load()
    return vp ?? { x: 0, y: 0, zoom: 1 } // fresh folder: reset the view
  }

  const anyStreaming = (): boolean => get().nodes.some((n) => n.data.status === 'streaming')

  // A fresh node takes over both kinds of focus: it becomes the selected node
  // (everything else deselects) and focusDraft moves the keyboard into it.
  const adopt = <T extends CanvasNode>(node: T): T => {
    const selected = { ...node, selected: true }
    set((s) => ({
      nodes: [...s.nodes.map((n) => (n.selected ? { ...n, selected: false } : n)), selected]
    }))
    persist()
    return selected
  }

  // Cycle the post-it palette: each fresh node takes the color after the
  // most recently created node's (the first one on a canvas gets butter).
  const nextColor = (): string => nextColorId(get().nodes[get().nodes.length - 1]?.data.color)

  const spawnNode = (position: { x: number; y: number }): ChatNode =>
    adopt(makeNode(position, { focusDraft: true, color: nextColor() }))

  const spawnNote = (position: { x: number; y: number }): NoteNode => {
    const node = adopt(makeNoteNode(position, { focusDraft: true, color: nextColor() }))
    // The note's file exists from the moment the node does — main allocates
    // a unique "Untitled" filename at the folder root.
    void window.api.note.create(node.id)
    return node
  }

  return {
    nodes: [],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
    loaded: false,
    folder: null,
    model: loadModel(),
    anchorOffsets: {},
    pendingDeleteId: null,
    placing: null,

    setPlacing: (kind) => set({ placing: kind }),

    setModel: (model) => {
      set({ model })
      localStorage.setItem(MODEL_STORAGE_KEY, model)
    },

    requestDelete: (id) => set({ pendingDeleteId: id }),

    cancelDelete: () => set({ pendingDeleteId: null }),

    deleteChat: (id, cascade) => {
      const byId = new Map(get().nodes.map((n) => [n.id, n]))
      const doomed = cascade ? forkSubtree(get().edges, id) : new Set([id])
      set((s) => ({
        pendingDeleteId: null,
        nodes: s.nodes.filter((n) => !doomed.has(n.id)),
        edges: s.edges.filter((e) => !doomed.has(e.source) && !doomed.has(e.target))
      }))
      for (const nodeId of doomed) {
        const node = byId.get(nodeId)
        if (node && isNote(node)) void window.api.note.delete(nodeId)
        else void window.api.canvas.deleteThread(nodeId)
      }
      persist()
    },

    setAnchorOffsets: (nodeId, offsets) => {
      set((s) => {
        const prev = s.anchorOffsets[nodeId]
        const unchanged =
          prev &&
          Object.keys(prev).length === Object.keys(offsets).length &&
          Object.entries(offsets).every(([k, v]) => prev[k] === v)
        if (unchanged) return {}
        return { anchorOffsets: { ...s.anchorOffsets, [nodeId]: offsets } }
      })
    },

    init: async () => {
      const folder = await window.api.folder.get()
      set({ folder })
      if (!folder.current) return null
      return get().load()
    },

    chooseFolder: async () => {
      if (anyStreaming()) return null
      await flushSave()
      return switchFolder(await window.api.folder.choose())
    },

    selectFolder: async (path) => {
      if (path === get().folder?.current || anyStreaming()) return null
      await flushSave()
      return switchFolder(await window.api.folder.select(path))
    },

    persistSoon: persist,

    persistThread,

    onNodesChange: (changes) => {
      set((s) => ({ nodes: applyNodeChanges(changes, s.nodes) }))
      persist()
    },

    setViewport: (viewport) => {
      set({ viewport })
      persist()
    },

    addNodeAt: (position) => spawnNode(position),

    addNoteAt: (position) => spawnNote(position),

    clearFocusDraft: (id) => patchData(id, { focusDraft: undefined }),

    setDraft: (id, draft) => patchData(id, { draft }),

    setColor: (id, color) => {
      patchData(id, { color })
      persist()
    },

    setTitle: (id, title) => {
      patchData(id, { title })
      persist()
    },

    // Title editing settled — rename the note's file to match. Main may
    // adjust the title (sanitized, suffixed if taken); adopt what it used.
    commitNoteTitle: async (id) => {
      const node = get().nodes.find((n) => n.id === id)
      if (!node || !isNote(node)) return
      const res = await window.api.note.rename(id, node.data.title)
      if (res && res.title !== node.data.title) patchData(id, { title: res.title })
      persist() // canvas.json picks up the new filename from main
    },

    setNoteContent: (id, content) => {
      // Notes grow with their content the way chats grow with replies:
      // editing releases any fixed height and caps growth to the screen.
      const growthCap = viewportFitHeight(get().viewport.zoom)
      set((s) => ({
        nodes: s.nodes.map((n) =>
          n.id === id
            ? ({ ...n, height: undefined, data: { ...n.data, content, growthCap } } as CanvasNode)
            : n
        )
      }))
      const timer = noteSaveTimers.get(id)
      if (timer) clearTimeout(timer)
      noteSaveTimers.set(
        id,
        setTimeout(() => {
          noteSaveTimers.delete(id)
          void window.api.note.save(id, content)
        }, 600)
      )
    },

    toggleResearch: (id) => {
      const node = get().nodes.find((n) => n.id === id)
      if (node && isChat(node)) patchData(id, { researchArmed: !node.data.researchArmed })
    },

    setViewVersion: (id, index) => patchData(id, { viewVersion: index }),

    restoreVersion: async (id, index) => {
      const node = get().nodes.find((n) => n.id === id)
      if (!node || !isNote(node) || node.data.status === 'streaming') return
      await flushNoteSave(id)
      const res = await window.api.note.restore(id, index)
      if (res)
        patchData(id, { content: res.content, versions: res.versions, viewVersion: undefined })
    },

    respondPermission: (id, requestId, allow) => {
      const node = get().nodes.find((n) => n.id === id)
      if (node?.data.pendingPermission?.requestId !== requestId) return
      // Dismiss immediately; main echoes a permission-resolved event regardless.
      patchData(id, { pendingPermission: undefined })
      window.api.thread.respondPermission({ requestId, allow })
    },

    forkChat: (nodeId) => {
      const parent = get().nodes.find((n) => n.id === nodeId)
      if (!parent || !isChat(parent) || parent.data.status === 'streaming') return null
      // Fork-ahead only: the anchor is always the chat's tip — its latest
      // assistant reply. Forking again later anchors on the new tip, and
      // several forks of the same tip simply share an anchor message.
      const anchor = [...parent.data.messages]
        .reverse()
        .find((m) => m.role === 'assistant' && m.uuid)
      const sessionId = parent.data.sessionId
      if (!anchor?.uuid || !sessionId) return null

      // Existing forks of this same anchor — the new one slots in beneath them.
      const siblingIds = new Set(
        get()
          .edges.filter((e) => e.source === parent.id && e.sourceMessageId === anchor.id)
          .map((e) => e.target)
      )
      const siblings = get().nodes.filter((n) => siblingIds.has(n.id))

      // The forked session carries the parent's context up to the anchor —
      // the node's transcript starts clean and shows only what diverges.
      const node = makeNode(findForkSpot(get().nodes, parent, siblings), {
        title: `${parent.data.title} ⑂`.trim(),
        color: parent.data.color, // forks stay in the parent's color family
        status: 'idle',
        growthCap: parent.data.growthCap,
        focusDraft: true,
        forkOf: { sessionId, messageUuid: anchor.uuid }
      })
      const edge: PersistedEdge = {
        id: uid(),
        source: parent.id,
        target: node.id,
        sourceMessageId: anchor.id
      }
      // Selection moves with the keyboard (like adopt): without it the fork's
      // transcript won't scroll — useForwardedWheel pans the canvas instead.
      set((s) => ({
        nodes: [
          ...s.nodes.map((n) => (n.selected ? { ...n, selected: false } : n)),
          { ...node, selected: true }
        ],
        edges: [...s.edges, edge]
      }))
      persist()
      return node.id
    },

    discardNode: (id) => {
      const node = get().nodes.find((n) => n.id === id)
      set((s) => ({
        nodes: s.nodes.filter((n) => n.id !== id),
        edges: s.edges.filter((e) => e.source !== id && e.target !== id)
      }))
      if (node && isNote(node)) void window.api.note.delete(id)
      else void window.api.canvas.deleteThread(id)
      persist()
    },

    toggleMinimize: (id) => {
      set((s) => ({
        nodes: s.nodes.map((n) => {
          if (n.id !== id) return n
          if (n.data.minimized) {
            // expand: restore the explicit height if there was one
            return {
              ...n,
              height: n.data.savedHeight,
              data: { ...n.data, minimized: false, savedHeight: undefined }
            } as CanvasNode
          }
          // minimize: drop the explicit height so the node collapses to the title row
          return {
            ...n,
            height: undefined,
            data: { ...n.data, minimized: true, savedHeight: n.height }
          } as CanvasNode
        })
      }))
      persist()
    },

    send: (id) => {
      const node = get().nodes.find((n) => n.id === id)
      if (!node || !isChat(node) || node.data.status === 'streaming') return
      const text = node.data.draft.trim()
      if (!text) return

      const userMsg: Message = { id: uid(), role: 'user', text }
      const assistantMsg: Message = { id: uid(), role: 'assistant', text: '' }
      // Sized to the screen at send time so the reply never grows past the
      // viewport — once the node hits the cap, the transcript scrolls instead.
      const growthCap = viewportFitHeight(get().viewport.zoom)
      set((s) => ({
        nodes: s.nodes.map((n) =>
          n.id === id
            ? ({
                ...n,
                // release any fixed height so the node grows with the reply (up to the cap)
                height: undefined,
                data: {
                  ...n.data,
                  messages: [...node.data.messages, userMsg, assistantMsg],
                  draft: '',
                  status: 'streaming' as const,
                  growthCap,
                  title: node.data.title || text.slice(0, 60),
                  researchArmed: false // one-shot: research applies to this send only
                }
              } as CanvasNode)
            : n
        )
      }))
      persist() // title may have changed
      persistThread(id) // the user message is part of the durable transcript now

      void window.api.thread.send({
        nodeId: id,
        text,
        sessionId: node.data.sessionId,
        model: get().model,
        // first send of a forked node: fork the parent session at the anchor
        ...(!node.data.sessionId && node.data.forkOf ? { forkFrom: node.data.forkOf } : {}),
        ...(node.data.researchArmed ? { research: true } : {})
      })
    },

    sendNote: async (id) => {
      const node = get().nodes.find((n) => n.id === id)
      if (!node || !isNote(node) || node.data.status === 'streaming') return
      const text = node.data.draft.trim()
      if (!text) return

      const growthCap = viewportFitHeight(get().viewport.zoom)
      set((s) => ({
        nodes: s.nodes.map((n) =>
          n.id === id
            ? ({
                ...n,
                // release any fixed height so the note grows with the AI's edits
                height: undefined,
                data: {
                  ...n.data,
                  draft: '',
                  status: 'streaming' as const,
                  lastReply: '',
                  viewVersion: undefined, // an editing turn always lands on the live content
                  growthCap
                }
              } as CanvasNode)
            : n
        )
      }))
      // The agent reads the note from disk — the latest keystrokes must be there.
      await flushNoteSave(id)
      void window.api.thread.send({
        nodeId: id,
        text,
        sessionId: node.data.sessionId,
        model: get().model,
        kind: 'note',
        noteTitle: node.data.title
      })
    },

    load: async () => {
      const doc = await window.api.canvas.load()
      if (!doc) {
        set({ loaded: true })
        return null
      }
      // Heights saved on a bigger screen may not fit this one — clamp on the way in.
      const cap = viewportFitHeight(doc.viewport.zoom)
      set({
        loaded: true,
        viewport: doc.viewport,
        edges: doc.edges ?? [],
        nodes: doc.nodes.map((p) => {
          const frame = {
            id: p.id,
            width: p.width,
            ...(p.height != null && !p.minimized ? { height: Math.min(p.height, cap) } : {})
          }
          const savedHeight = p.minimized && p.height != null ? Math.min(p.height, cap) : undefined
          if (p.kind === 'note') {
            return {
              ...makeNoteNode(p.position, {
                title: p.title,
                color: p.color,
                content: p.content ?? '',
                versions: p.noteVersions ?? [],
                status: 'idle',
                minimized: p.minimized ?? false,
                savedHeight,
                growthCap: cap,
                sessionId: p.sessionId
              }),
              ...frame
            }
          }
          return {
            ...makeNode(p.position, {
              title: p.title,
              color: p.color,
              messages: p.messages ?? [],
              status: p.title || (p.messages?.length ?? 0) > 0 ? 'idle' : 'empty',
              minimized: p.minimized ?? false,
              savedHeight,
              growthCap: cap,
              sessionId: p.sessionId,
              forkOf: p.forkOf,
              ...(p.kind === 'research' ? { kind: 'research' as const } : {})
            }),
            ...frame
          }
        })
      })
      return doc.viewport
    }
  }
})

// Stream events from the main process (one Agent SDK query per turn, any number of
// nodes streaming concurrently). Registered once at module load.
window.api.thread.onEvent((event) => {
  const { setState } = useCanvasStore
  const patch = (id: string, fn: (node: CanvasNode) => Record<string, unknown>): void => {
    setState((s) => ({
      nodes: s.nodes.map((n) =>
        n.id === id ? ({ ...n, data: { ...n.data, ...fn(n) } } as CanvasNode) : n
      )
    }))
  }

  if (event.type === 'session' && event.sessionId) {
    // The fork (if any) has materialized into its own session — drop the pending ref.
    patch(event.nodeId, () => ({ sessionId: event.sessionId, forkOf: undefined }))
    useCanvasStore.getState().persistSoon()
  } else if (event.type === 'delta' && event.text) {
    patch(event.nodeId, (node) => {
      // Note turns route the assistant's commentary into the reply strip.
      if (isNote(node)) return { lastReply: (node.data.lastReply ?? '') + event.text }
      const last = node.data.messages[node.data.messages.length - 1]
      if (!last || last.role !== 'assistant') return {}
      return {
        messages: [...node.data.messages.slice(0, -1), { ...last, text: last.text + event.text }]
      }
    })
  } else if (event.type === 'spawn') {
    // The lead called the Agent tool — give the researcher its own child node,
    // wired to the lead's streaming assistant message like a fork edge.
    const s = useCanvasStore.getState()
    const parent = s.nodes.find((n) => n.id === event.nodeId)
    if (!parent || !isChat(parent)) return
    const anchor = parent.data.messages[parent.data.messages.length - 1]
    const siblingIds = new Set(
      s.edges
        .filter((e) => e.source === parent.id && e.sourceMessageId === anchor?.id)
        .map((e) => e.target)
    )
    const child = makeNode(
      findForkSpot(
        s.nodes,
        parent,
        s.nodes.filter((n) => siblingIds.has(n.id))
      ),
      {
        kind: 'research',
        title: event.description,
        color: parent.data.color,
        status: 'streaming',
        growthCap: parent.data.growthCap,
        // Born collapsed — the header dots show it's working; expand to watch.
        minimized: true,
        messages: [{ id: uid(), role: 'assistant', text: '' }]
      }
    )
    researchChildren.set(`${event.nodeId}:${event.toolUseId}`, child.id)
    setState((st) => ({
      nodes: [...st.nodes, child],
      edges: [
        ...st.edges,
        { id: uid(), source: parent.id, target: child.id, sourceMessageId: anchor?.id ?? '' }
      ]
    }))
    useCanvasStore.getState().persistSoon()
  } else if (event.type === 'childDelta') {
    const childId = researchChildren.get(`${event.nodeId}:${event.toolUseId}`)
    if (!childId) return // late delta for a child we never spawned — drop it
    patch(childId, (node) => {
      if (!isChat(node)) return {}
      const last = node.data.messages[node.data.messages.length - 1]
      if (!last || last.role !== 'assistant') return {}
      return {
        messages: [...node.data.messages.slice(0, -1), { ...last, text: last.text + event.text }]
      }
    })
  } else if (event.type === 'childDone') {
    const key = `${event.nodeId}:${event.toolUseId}`
    const childId = researchChildren.get(key)
    researchChildren.delete(key)
    if (childId) {
      patch(childId, () => ({ status: 'idle' }))
      useCanvasStore.getState().persistThread(childId)
      useCanvasStore.getState().persistSoon()
    }
  } else if (event.type === 'note-content') {
    patch(event.nodeId, (node) => (isNote(node) ? { content: event.content } : {}))
  } else if (event.type === 'permission') {
    patch(event.nodeId, () => ({ pendingPermission: event.request }))
  } else if (event.type === 'permission-resolved') {
    patch(event.nodeId, (node) =>
      node.data.pendingPermission?.requestId === event.requestId
        ? { pendingPermission: undefined }
        : {}
    )
  } else if (event.type === 'done') {
    // Safety sweep: a turn that errored or aborted mid-research leaves no
    // childDone behind — settle any of this lead's still-streaming children.
    for (const [key, childId] of researchChildren) {
      if (key.startsWith(`${event.nodeId}:`)) {
        researchChildren.delete(key)
        patch(childId, () => ({ status: 'idle' }))
        useCanvasStore.getState().persistThread(childId)
      }
    }
    patch(event.nodeId, (node) => {
      const warning = event.ok === false ? `\n\n⚠️ ${event.error ?? 'The agent run failed.'}` : ''
      if (isNote(node)) {
        return {
          status: 'idle',
          pendingPermission: undefined,
          ...(event.usage ? { lastUsage: event.usage } : {}),
          // adopt the turn's settled content + version history
          ...(event.note ? { content: event.note.content, versions: event.note.versions } : {}),
          ...(warning ? { lastReply: (node.data.lastReply ?? '') + warning } : {})
        }
      }
      const last = node.data.messages[node.data.messages.length - 1]
      return {
        status: 'idle',
        pendingPermission: undefined, // safety net if the turn dies mid-prompt
        ...(event.usage ? { lastUsage: event.usage } : {}),
        messages:
          last && last.role === 'assistant'
            ? [
                ...node.data.messages.slice(0, -1),
                // stamp the SDK uuid — it's the anchor that makes this message forkable
                {
                  ...last,
                  text: last.text + warning,
                  ...(event.messageUuid ? { uuid: event.messageUuid } : {})
                }
              ]
            : node.data.messages
      }
    })
    useCanvasStore.getState().persistThread(event.nodeId)
  }
})
