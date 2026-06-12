import { create } from 'zustand'
import { applyNodeChanges, type Node, type NodeChange, type Viewport } from '@xyflow/react'
import { DEFAULT_MODEL, MODEL_OPTIONS } from '../../../shared/types'
import type {
  CanvasDoc,
  ChosenFile,
  ContextFile,
  FileKind,
  FolderState,
  ForkRef,
  ModelId,
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

export type ChatStatus = 'empty' | 'idle' | 'streaming' | 'error'

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
  lastError?: string // what the failed turn said; shown while status === 'error'
  pendingPermission?: PermissionRequest // tool call awaiting the user's Allow/Deny
  // Research children are display-only researcher transcripts: no composer,
  // no forking, no session of their own (they ran inside the lead's session).
  kind?: 'research'
  researchArmed?: boolean // composer toggle: the next send runs in research mode
  // File node ids (images and PDFs) whose bytes this chat's session has
  // already seen — only newly connected files ride the next send as blocks.
  // The name predates PDF support; kept for canvas.json compatibility.
  injectedImages?: string[]
  // Epoch ms of the last content activity (send, turn settled, edit) —
  // the sidebar lists nodes most-recent first by this.
  updatedAt?: number
  [key: string]: unknown
}

export interface NoteData {
  title: string
  color?: string
  content: string // live markdown, mirror of the note's title-named file
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
  updatedAt?: number // see ChatData.updatedAt
  [key: string]: unknown
}

export interface FileData {
  title: string
  color?: string
  kind?: FileKind // omitted means 'image' (nodes that predate PDFs)
  file?: string // file path relative to the folder root; set once file:attach resolves
  dataUrl?: string // image bytes; undefined renders a placeholder (PDFs never carry one)
  minimized: boolean
  savedHeight?: number
  updatedAt?: number // never stamped (files don't sit in the sidebar); declared so CanvasNode data reads uniformly
  [key: string]: unknown
}

export type ChatNode = Node<ChatData, 'chat'>
export type NoteNode = Node<NoteData, 'note'>
export type FileNode = Node<FileData, 'file'>
export type CanvasNode = ChatNode | NoteNode | FileNode

export const isChat = (n: CanvasNode): n is ChatNode => n.type === 'chat'
export const isNote = (n: CanvasNode): n is NoteNode => n.type === 'note'
export const isFile = (n: CanvasNode): n is FileNode => n.type === 'file'

// A file node's frame is explicit (width AND height) from birth so resizing
// can keep the aspect ratio. The header band is part of that frame.
export const FILE_HEADER_H = 49
const MIN_FILE_W = 240
// PDFs open as an inline pdf.js viewer — born at roughly one US-Letter page
// (at 480 wide a page is ~620 tall), freely resizable since the pages scroll.
export const PDF_FRAME = { width: 480, height: FILE_HEADER_H + 620 }

/** A picked file riding the placement ghost — images carry their measured
 *  pixel size; PDFs place at the standard viewer frame. */
export interface PendingFile extends ChosenFile {
  naturalWidth?: number
  naturalHeight?: number
}

/** Initial frame for a file node: an image's natural size, capped to the
 *  standard node width and max height (whichever bites first), aspect
 *  preserved — or the page-sized viewer frame when there's nothing to
 *  measure (PDFs). */
export function fileFrame(pf: { naturalWidth?: number; naturalHeight?: number }): {
  width: number
  height: number
} {
  if (!pf.naturalWidth || !pf.naturalHeight) return { ...PDF_FRAME }
  let width = Math.max(MIN_FILE_W, Math.min(NODE_W, pf.naturalWidth))
  let imgH = (width * pf.naturalHeight) / pf.naturalWidth
  const maxImg = MAX_NODE_H - FILE_HEADER_H
  if (imgH > maxImg) {
    imgH = maxImg
    width = Math.max(MIN_FILE_W, Math.round((imgH * pf.naturalWidth) / pf.naturalHeight))
  }
  return { width, height: Math.round(imgH + FILE_HEADER_H) }
}

/** Decode an image data URL to its natural pixel size (null if undecodable). */
function measureImage(dataUrl: string): Promise<{ w: number; h: number } | null> {
  return new Promise((resolveDims) => {
    const img = new Image()
    img.onload = () => resolveDims({ w: img.naturalWidth, h: img.naturalHeight })
    img.onerror = () => resolveDims(null)
    img.src = dataUrl
  })
}

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
      status: 'idle',
      draft: '',
      minimized: false,
      ...partial
    }
  }
}

function makeFileNode(
  position: { x: number; y: number },
  frame: { width: number; height?: number },
  partial?: Partial<FileData>
): FileNode {
  return {
    id: uid(),
    type: 'file',
    position,
    width: frame.width,
    ...(frame.height != null ? { height: frame.height } : {}),
    dragHandle: '.drag-handle',
    data: { title: '', minimized: false, ...partial }
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

/** A node plus every chat forked from it, transitively (fork edges run source → target).
 *  Context edges don't count — a note feeding a chat doesn't own it. */
export function forkSubtree(edges: PersistedEdge[], rootId: string): Set<string> {
  const ids = new Set([rootId])
  let grew = true
  while (grew) {
    grew = false
    for (const e of edges) {
      if (e.kind === 'context') continue
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
  // placement click on the canvas (armed by the toolbar buttons / C / N / F).
  placing: 'chat' | 'note' | 'file' | null
  setPlacing: (kind: 'chat' | 'note' | 'file' | null) => void
  // Runtime-only: the picked image riding the file-placement ghost.
  pendingFile: PendingFile | null
  // Open the image picker; on a pick, arm file placement with the image ghost.
  startFilePlacement: () => Promise<void>
  // Runtime-only: click-to-connect. A tap on a note's or image's circle arms
  // it; the pending context arrow follows the cursor (ContextConnectOverlay)
  // until a click on a chat commits the edge — or any other click / Esc cancels.
  ctxConnectSource: string | null
  setCtxConnectSource: (id: string | null) => void
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
  addFileAt: (position: { x: number; y: number }) => FileNode | null
  // OS drag-and-drop: place each dropped image/PDF as a file node centered on
  // the drop point (cascading when several arrive together) and attach it.
  addDroppedFiles: (point: { x: number; y: number }, picked: ChosenFile[]) => Promise<void>
  clearFocusDraft: (id: string) => void
  setDraft: (id: string, draft: string) => void
  setColor: (id: string, color: string) => void
  setTitle: (id: string, title: string) => void
  commitNoteTitle: (id: string) => Promise<void>
  setNoteContent: (id: string, content: string) => void
  send: (id: string) => void
  retry: (id: string) => void
  sendNote: (id: string) => Promise<void>
  toggleResearch: (id: string) => void
  respondPermission: (id: string, requestId: string, allow: boolean) => void
  forkChat: (nodeId: string) => string | null
  distillChat: (nodeId: string) => Promise<string | null>
  // Context edges: a note or image feeding a chat's system prompt
  // (note/image → chat only).
  addContextEdge: (sourceId: string, chatId: string) => void
  removeContextEdge: (edgeId: string) => void
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
// File ids riding the in-flight turn as image/document blocks, per chat node.
// Marked injected only when the turn lands ok — a failed turn re-sends them
// on retry.
const pendingFileInjections = new Map<string, string[]>()

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
            : isFile(n)
              ? { kind: 'file' as const, ...(n.data.file ? { file: n.data.file } : {}) }
              : n.data.kind === 'research'
                ? { kind: 'research' as const }
                : {}),
          position: n.position,
          width: n.width ?? NODE_W,
          ...(height != null ? { height } : {}),
          title: n.data.title,
          ...(n.data.updatedAt != null ? { updatedAt: n.data.updatedAt } : {}),
          ...(n.data.color ? { color: n.data.color } : {}),
          ...(n.data.minimized ? { minimized: true } : {}),
          ...(!isFile(n) && n.data.sessionId ? { sessionId: n.data.sessionId } : {}),
          ...(isChat(n) && n.data.forkOf ? { forkOf: n.data.forkOf } : {}),
          ...(isChat(n) && n.data.injectedImages?.length
            ? { injectedImages: n.data.injectedImages }
            : {})
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
    set({
      folder: next,
      nodes: [],
      edges: [],
      viewport: { x: 0, y: 0, zoom: 1 },
      placing: null,
      pendingFile: null
    })
    const vp = await get().load()
    return vp ?? { x: 0, y: 0, zoom: 1 } // fresh folder: reset the view
  }

  const anyStreaming = (): boolean => get().nodes.some((n) => n.data.status === 'streaming')

  // Notes wired to a chat by context edges go along with every send — read
  // from the store, which always holds the freshest content (autosave
  // debounce notwithstanding).
  const contextNotesFor = (id: string): { id: string; title: string; content: string }[] =>
    get()
      .edges.filter((e) => e.kind === 'context' && e.target === id)
      .flatMap((e) => {
        const src = get().nodes.find((n) => n.id === e.source)
        return src && isNote(src)
          ? [{ id: src.id, title: src.data.title || 'Untitled note', content: src.data.content }]
          : []
      })

  // Files wired to a chat go along as paths; main injects the bytes of any
  // the session hasn't seen (isNew, stamped by send/retry) into the turn's
  // user message. A file whose attach hasn't landed yet (no path) sits out.
  const contextFilesFor = (id: string): ContextFile[] =>
    get()
      .edges.filter((e) => e.kind === 'context' && e.target === id)
      .flatMap((e) => {
        const src = get().nodes.find((n) => n.id === e.source)
        return src && isFile(src) && src.data.file
          ? [
              {
                id: src.id,
                title:
                  src.data.title || (src.data.kind === 'pdf' ? 'Untitled PDF' : 'Untitled image'),
                file: src.data.file
              }
            ]
          : []
      })

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

  // Materialize a file node at a top-left position and make the file part of
  // the folder (copy in, or reference in place) — the relative path from
  // file:attach is what survives a reload.
  const placeFile = (position: { x: number; y: number }, pf: PendingFile): FileNode => {
    const node = adopt(
      makeFileNode(position, fileFrame(pf), {
        title: pf.name.replace(/\.[^.]+$/, ''), // the original file name, sans extension
        color: nextColor(),
        kind: pf.kind,
        ...(pf.dataUrl ? { dataUrl: pf.dataUrl } : {})
      })
    )
    void window.api.file.attach(pf.sourcePath).then((res) => {
      if (res) {
        patchData(node.id, { file: res.file })
        persist()
      }
    })
    return node
  }

  const spawnNode = (position: { x: number; y: number }): ChatNode =>
    adopt(makeNode(position, { focusDraft: true, color: nextColor(), updatedAt: Date.now() }))

  const spawnNote = (position: { x: number; y: number }): NoteNode => {
    const node = adopt(
      makeNoteNode(position, { focusDraft: true, color: nextColor(), updatedAt: Date.now() })
    )
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
    pendingFile: null,
    ctxConnectSource: null,

    // The pending image lives and dies with file-placement mode.
    setPlacing: (kind) =>
      set(kind === 'file' ? { placing: kind } : { placing: kind, pendingFile: null }),

    startFilePlacement: async () => {
      const picked = await window.api.file.choose()
      if (!picked) return
      // PDFs place as a fixed card — nothing to measure.
      if (picked.kind === 'pdf' || !picked.dataUrl) {
        set({ placing: 'file', pendingFile: picked })
        return
      }
      // Measure the image before placing — the node's frame comes from it.
      const dims = await measureImage(picked.dataUrl)
      if (!dims || dims.w === 0 || dims.h === 0) return
      set({
        placing: 'file',
        pendingFile: { ...picked, naturalWidth: dims.w, naturalHeight: dims.h }
      })
    },

    setCtxConnectSource: (id) => set({ ctxConnectSource: id }),

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
        else if (node && isFile(node)) {
          // the file stays in the folder — the node is just a pin
        } else void window.api.canvas.deleteThread(nodeId)
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

    addFileAt: (position) => {
      const pf = get().pendingFile
      if (!pf) return null
      const node = placeFile(position, pf)
      set({ pendingFile: null })
      return node
    },

    addDroppedFiles: async (point, picked) => {
      let offset = 0
      for (const chosen of picked) {
        const pf: PendingFile = { ...chosen }
        if (pf.dataUrl) {
          // The node's frame comes from the image's natural size.
          const dims = await measureImage(pf.dataUrl)
          if (!dims || dims.w === 0 || dims.h === 0) continue
          pf.naturalWidth = dims.w
          pf.naturalHeight = dims.h
        }
        const { width } = fileFrame(pf)
        placeFile({ x: point.x - width / 2 + offset, y: point.y + offset }, pf)
        offset += 48
      }
    },

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
            ? ({
                ...n,
                height: undefined,
                data: { ...n.data, content, growthCap, updatedAt: Date.now() }
              } as CanvasNode)
            : n
        )
      }))
      persist() // updatedAt must survive a reload — content itself saves via note.save below
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

    respondPermission: (id, requestId, allow) => {
      const node = get().nodes.find((n) => n.id === id)
      if (!node || isFile(node) || node.data.pendingPermission?.requestId !== requestId) return
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
        updatedAt: Date.now(),
        forkOf: { sessionId, messageUuid: anchor.uuid },
        // the forked session inherits the parent's transcript — and with it,
        // any files already injected there
        injectedImages: parent.data.injectedImages
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

    // Distill the chat into a fresh note: fork the chat's session at its tip
    // (the whole conversation rides along — and the prompt cache with it) and
    // run a note-editing turn that writes the key insights into the new
    // note's file. The note is a free-stander: chat's color, no edges.
    distillChat: async (nodeId) => {
      const parent = get().nodes.find((n) => n.id === nodeId)
      if (!parent || !isChat(parent) || parent.data.status === 'streaming') return null
      const anchor = [...parent.data.messages]
        .reverse()
        .find((m) => m.role === 'assistant' && m.uuid)
      const sessionId = parent.data.sessionId
      if (!anchor?.uuid || !sessionId) return null

      const wanted = parent.data.title ? `${parent.data.title} — insights` : 'Key insights'
      // Right of the chat, same level — deliberately dumb placement
      // (overlapping neighbors is fine). Spawned unselected, and nobody's
      // selection is touched: sharing a selection with the chat would make
      // React Flow drag the two around as a unit.
      const p = boxOf(parent)
      const node = makeNoteNode(
        { x: p.x + p.w + GAP, y: p.y },
        {
          title: wanted,
          color: parent.data.color,
          status: 'streaming',
          growthCap: viewportFitHeight(get().viewport.zoom),
          updatedAt: Date.now()
        }
      )
      set((s) => ({ nodes: [...s.nodes, node] }))
      persist()

      // The editing turn needs the note's file on disk under its real title
      // (create allocates "Untitled"; rename moves it, dodging collisions).
      await window.api.note.create(node.id)
      const slot = await window.api.note.rename(node.id, wanted)
      if (slot && slot.title !== wanted) patchData(node.id, { title: slot.title })
      persist() // canvas.json picks up the filename from main

      void window.api.thread.send({
        nodeId: node.id,
        text:
          'Distill the conversation so far into its key insights. Write a markdown ' +
          'bulleted list of 5-10 insights into the note — each one concise, specific, ' +
          'and substantive. No preamble and no headings, just the list.',
        model: get().model,
        kind: 'note',
        noteTitle: slot?.title ?? wanted,
        forkFrom: { sessionId, messageUuid: anchor.uuid }
      })
      return node.id
    },

    addContextEdge: (sourceId, chatId) => {
      const s = get()
      const src = s.nodes.find((n) => n.id === sourceId)
      const tgt = s.nodes.find((n) => n.id === chatId)
      if (!src || !tgt || !(isNote(src) || isFile(src)) || !isChat(tgt)) return
      if (tgt.data.kind === 'research') return
      if (s.edges.some((e) => e.kind === 'context' && e.source === sourceId && e.target === chatId))
        return // already connected
      set((st) => ({
        edges: [...st.edges, { id: uid(), source: sourceId, target: chatId, kind: 'context' }]
      }))
      persist()
    },

    removeContextEdge: (edgeId) => {
      set((s) => ({ edges: s.edges.filter((e) => e.id !== edgeId) }))
      persist()
    },

    discardNode: (id) => {
      const node = get().nodes.find((n) => n.id === id)
      set((s) => ({
        nodes: s.nodes.filter((n) => n.id !== id),
        edges: s.edges.filter((e) => e.source !== id && e.target !== id)
      }))
      if (node && isNote(node)) void window.api.note.delete(id)
      else if (node && isFile(node)) {
        // the file stays in the folder
      } else void window.api.canvas.deleteThread(id)
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
                  updatedAt: Date.now(),
                  lastError: undefined, // a fresh send supersedes any failed turn
                  title: node.data.title || text.slice(0, 60),
                  researchArmed: false // one-shot: research applies to this send only
                }
              } as CanvasNode)
            : n
        )
      }))
      persist() // title may have changed
      persistThread(id) // the user message is part of the durable transcript now

      const contextNotes = contextNotesFor(id)
      // Only files the session hasn't seen carry bytes this turn; remember
      // them so a successful turn marks them injected.
      const injected = new Set(node.data.injectedImages ?? [])
      const contextFiles = contextFilesFor(id).map((f) => ({
        ...f,
        isNew: !injected.has(f.id)
      }))
      const newFileIds = contextFiles.filter((f) => f.isNew).map((f) => f.id)
      if (newFileIds.length > 0) pendingFileInjections.set(id, newFileIds)
      else pendingFileInjections.delete(id)

      void window.api.thread.send({
        nodeId: id,
        text,
        sessionId: node.data.sessionId,
        model: get().model,
        // first send of a forked node: fork the parent session at the anchor
        ...(!node.data.sessionId && node.data.forkOf ? { forkFrom: node.data.forkOf } : {}),
        ...(node.data.researchArmed ? { research: true } : {}),
        ...(contextNotes.length > 0 ? { contextNotes } : {}),
        ...(contextFiles.length > 0 ? { contextFiles } : {})
      })
    },

    // Re-run a failed turn: same prompt, same session. The session resume may
    // already hold the failed turn's partial output — acceptable; the retry
    // prompt repeats and the model answers fresh.
    retry: (id) => {
      const node = get().nodes.find((n) => n.id === id)
      if (!node || !isChat(node) || node.data.status !== 'error') return
      const lastUser = [...node.data.messages].reverse().find((m) => m.role === 'user')
      if (!lastUser) return

      // Stream into the failed turn's bubble: reuse a trailing assistant
      // message, or add a fresh placeholder if the turn died before one landed.
      const last = node.data.messages[node.data.messages.length - 1]
      const messages: Message[] =
        last && last.role === 'assistant'
          ? [...node.data.messages.slice(0, -1), { ...last, text: '' }]
          : [...node.data.messages, { id: uid(), role: 'assistant', text: '' }]

      const growthCap = viewportFitHeight(get().viewport.zoom)
      set((s) => ({
        nodes: s.nodes.map((n) =>
          n.id === id
            ? ({
                ...n,
                height: undefined,
                data: {
                  ...n.data,
                  messages,
                  status: 'streaming' as const,
                  growthCap,
                  updatedAt: Date.now(),
                  lastError: undefined
                }
              } as CanvasNode)
            : n
        )
      }))

      const contextNotes = contextNotesFor(id)
      const injected = new Set(node.data.injectedImages ?? [])
      const contextFiles = contextFilesFor(id).map((f) => ({
        ...f,
        isNew: !injected.has(f.id)
      }))
      const newFileIds = contextFiles.filter((f) => f.isNew).map((f) => f.id)
      if (newFileIds.length > 0) pendingFileInjections.set(id, newFileIds)
      else pendingFileInjections.delete(id)
      void window.api.thread.send({
        nodeId: id,
        text: lastUser.text,
        sessionId: node.data.sessionId,
        model: get().model,
        // the failed turn may have been a fork's first send — fork again
        ...(!node.data.sessionId && node.data.forkOf ? { forkFrom: node.data.forkOf } : {}),
        ...(contextNotes.length > 0 ? { contextNotes } : {}),
        ...(contextFiles.length > 0 ? { contextFiles } : {})
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
                  growthCap,
                  updatedAt: Date.now()
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
          if (p.kind === 'file') {
            // File frames are explicit and aspect-true — no screen-fit clamp.
            return {
              ...makeFileNode(
                p.position,
                {
                  width: p.width,
                  ...(p.height != null && !p.minimized ? { height: p.height } : {})
                },
                {
                  title: p.title,
                  color: p.color,
                  kind: p.file?.toLowerCase().endsWith('.pdf')
                    ? ('pdf' as const)
                    : ('image' as const),
                  file: p.file,
                  dataUrl: p.dataUrl,
                  minimized: p.minimized ?? false,
                  ...(p.minimized && p.height != null ? { savedHeight: p.height } : {})
                }
              ),
              id: p.id
            }
          }
          if (p.kind === 'note') {
            return {
              ...makeNoteNode(p.position, {
                title: p.title,
                color: p.color,
                content: p.content ?? '',
                status: 'idle',
                minimized: p.minimized ?? false,
                savedHeight,
                growthCap: cap,
                sessionId: p.sessionId,
                updatedAt: p.updatedAt
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
              injectedImages: p.injectedImages,
              updatedAt: p.updatedAt,
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
      if (!isChat(node)) return {}
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
      !isFile(node) && node.data.pendingPermission?.requestId === event.requestId
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
    // Files that rode this turn are in the session now (only if it landed —
    // a failed turn's files go again on retry).
    const injectedNow = event.ok ? pendingFileInjections.get(event.nodeId) : undefined
    pendingFileInjections.delete(event.nodeId)
    patch(event.nodeId, (node) => {
      if (isNote(node)) {
        const warning = event.ok === false ? `\n\n⚠️ ${event.error ?? 'The agent run failed.'}` : ''
        return {
          status: 'idle',
          pendingPermission: undefined,
          updatedAt: Date.now(),
          ...(event.usage ? { lastUsage: event.usage } : {}),
          // adopt the turn's settled content
          ...(event.note ? { content: event.note.content } : {}),
          ...(warning ? { lastReply: (node.data.lastReply ?? '') + warning } : {})
        }
      }
      if (!isChat(node)) return {}
      const last = node.data.messages[node.data.messages.length - 1]
      if (event.ok === false) {
        return {
          status: 'error', // the error strip (with Retry) takes it from here
          lastError: event.error ?? 'The turn failed.',
          pendingPermission: undefined,
          ...(event.usage ? { lastUsage: event.usage } : {}),
          // drop an untouched placeholder; keep whatever partial text streamed
          messages:
            last && last.role === 'assistant' && last.text === ''
              ? node.data.messages.slice(0, -1)
              : node.data.messages
        }
      }
      return {
        status: 'idle',
        lastError: undefined,
        pendingPermission: undefined, // safety net if the turn dies mid-prompt
        updatedAt: Date.now(),
        ...(event.usage ? { lastUsage: event.usage } : {}),
        ...(injectedNow?.length
          ? {
              injectedImages: [...new Set([...(node.data.injectedImages ?? []), ...injectedNow])]
            }
          : {}),
        messages:
          last && last.role === 'assistant'
            ? [
                ...node.data.messages.slice(0, -1),
                // stamp the SDK uuid — it's the anchor that makes this message forkable
                { ...last, ...(event.messageUuid ? { uuid: event.messageUuid } : {}) }
              ]
            : node.data.messages
      }
    })
    useCanvasStore.getState().persistThread(event.nodeId)
    // updatedAt (and injectedImages) round-trip through canvas.json — make them durable.
    useCanvasStore.getState().persistSoon()

    // First successful exchange still wearing its send-time stub (the opening
    // message's first 60 chars): swap in a real title from a one-shot Haiku
    // turn in the background. A user rename — before or during — wins.
    if (event.ok) {
      const node = useCanvasStore.getState().nodes.find((n) => n.id === event.nodeId)
      if (node && isChat(node) && node.data.kind !== 'research') {
        const firstUser = node.data.messages.find((m) => m.role === 'user')
        const stub = firstUser?.text.slice(0, 60)
        if (stub && node.data.title === stub) {
          const reply = node.data.messages.find((m) => m.role === 'assistant' && m.text)
          const conversation =
            `User: ${firstUser!.text.slice(0, 1500)}\n\n` +
            `Assistant: ${(reply?.text ?? '').slice(0, 1500)}`
          void window.api.thread.title(conversation).then((title) => {
            if (!title) return
            const cur = useCanvasStore.getState().nodes.find((n) => n.id === event.nodeId)
            if (cur && cur.data.title === stub) {
              useCanvasStore.getState().setTitle(event.nodeId, title)
            }
          })
        }
      }
    }
  }
})
