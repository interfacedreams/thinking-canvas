import { create } from 'zustand'
import { applyNodeChanges, type Node, type NodeChange, type Viewport } from '@xyflow/react'
import { DEFAULT_EFFORT, DEFAULT_MODEL, EFFORT_OPTIONS, MODEL_OPTIONS } from '../../../shared/types'
import type {
  CanvasDoc,
  ChosenFile,
  ContextFile,
  ContextLink,
  EffortId,
  FileKind,
  FolderState,
  ForkRef,
  ModelId,
  NoteVersion,
  PermissionRequest,
  PersistedEdge,
  PersistedMessage,
  TurnUsage
} from '../../../shared/types'
import { contrastColorId, nextColorId } from '../lib/palette'
import { extractPageMarkdown } from '../lib/pageText'

export const NODE_W = 600
export const MAX_NODE_H = 1280
// The always-present CLAUDE.md node: a fixed-id note whose body is the folder's
// CLAUDE.md. Main hard-maps this id to the root CLAUDE.md file. Injected on load
// if absent (see ensureClaudeMd), never deletable/renamable/pinnable.
export const CLAUDE_MD_ID = 'claude-md'
const CLAUDE_MD_POS = { x: 360, y: 32 } // clear of the top-left canvas legends
const MIN_GROW_H = 280
export const GAP = 24
// A derived note sits further right than a plain spawn — two background-dot
// units (the dot grid is 44px) of breathing room between source and summary.
export const DERIVE_GAP = 88

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
  // Prior content snapshots, oldest first — kept each time an AI turn touches
  // the note. The live content is `content`; these are the history behind it.
  versions: NoteVersion[]
  // Runtime-only: index into `versions` of the snapshot being viewed (read-
  // only). undefined means viewing the live, editable content.
  viewVersion?: number
  // Pinned into the project memory index — every new chat sees this note in
  // MEMORY.md and can read its file on demand.
  pinned?: boolean
  // The one persistent CLAUDE.md node (see CLAUDE_MD_ID): its body is the
  // folder's CLAUDE.md. Always present, never deleted/renamed/pinned.
  system?: 'claudeMd'
  // 1-3 sentence index description (Haiku-generated, cached). The MEMORY.md
  // line for a pinned note uses it.
  description?: string
  // Runtime-only: an agent edited this note's file while the user had unsaved
  // changes — the fresh on-disk content, parked behind a "Reload" prompt
  // rather than clobbering the user's edits.
  externalEdit?: { content: string }
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

export interface LinkData {
  title: string
  color?: string
  url?: string // empty until the user commits one — the body shows the URL input
  minimized: boolean
  savedHeight?: number
  updatedAt?: number // never stamped (links don't sit in the sidebar); declared so CanvasNode data reads uniformly
  [key: string]: unknown
}

export type ChatNode = Node<ChatData, 'chat'>
export type NoteNode = Node<NoteData, 'note'>
export type FileNode = Node<FileData, 'file'>
export type LinkNode = Node<LinkData, 'link'>
export type CanvasNode = ChatNode | NoteNode | FileNode | LinkNode

// How a node is opened out of its card: docked to the right ('panel') or
// covering the window ('full'). See CanvasState.expanded.
export type PanelMode = 'panel' | 'full'

export const isChat = (n: CanvasNode): n is ChatNode => n.type === 'chat'
export const isNote = (n: CanvasNode): n is NoteNode => n.type === 'note'
export const isFile = (n: CanvasNode): n is FileNode => n.type === 'file'
export const isLink = (n: CanvasNode): n is LinkNode => n.type === 'link'

// A file node's frame is explicit (width AND height) from birth so resizing
// can keep the aspect ratio. The header band is part of that frame.
export const FILE_HEADER_H = 49
const MIN_FILE_W = 240
// PDFs open as an inline pdf.js viewer — born at roughly one US-Letter page
// (at 480 wide a page is ~620 tall), freely resizable since the pages scroll.
export const PDF_FRAME = { width: 480, height: FILE_HEADER_H + 620 }
// Tabs are born as a slim search-or-link card; committing opens the full
// browser-card height (the page scrolls inside, like the PDF viewer).
export const LINK_INPUT_FRAME = { width: NODE_W, height: FILE_HEADER_H + 64 }
export const LINK_FRAME = { width: NODE_W, height: FILE_HEADER_H + 620 }

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
      versions: [],
      status: 'idle',
      draft: '',
      minimized: false,
      ...partial
    }
  }
}

/**
 * The version pager's derived state. Positions run 1..total, where the last
 * position is always the live (editable) content. When the live content has
 * drifted from the latest snapshot — unversioned user edits — it earns its own
 * extra trailing position so those edits are reachable too.
 */
export function notePager(data: {
  versions: NoteVersion[]
  content: string
  viewVersion?: number
}): { total: number; position: number; viewingOld: boolean } {
  const { versions } = data
  const drifted = versions.length > 0 && data.content !== versions[versions.length - 1].content
  const total = versions.length === 0 ? 1 : versions.length + (drifted ? 1 : 0)
  const viewingOld = data.viewVersion !== undefined && data.viewVersion < versions.length
  const position = viewingOld ? data.viewVersion! + 1 : total
  return { total, position, viewingOld }
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

/** A link node's default title: the URL's bare hostname ('' if unparsable). */
function hostTitle(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

function makeLinkNode(position: { x: number; y: number }, partial?: Partial<LinkData>): LinkNode {
  return {
    id: uid(),
    type: 'link',
    position,
    width: LINK_INPUT_FRAME.width,
    height: LINK_INPUT_FRAME.height,
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
 *  Context and derive edges don't count — a note feeding (or derived from) a
 *  chat is its own free-stander, not owned by the chat. */
export function forkSubtree(edges: PersistedEdge[], rootId: string): Set<string> {
  const ids = new Set([rootId])
  let grew = true
  while (grew) {
    grew = false
    for (const e of edges) {
      if (e.kind === 'context' || e.kind === 'output' || e.kind === 'derive') continue
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
  effort: EffortId // thinking effort for new turns; persisted app-wide in localStorage
  setEffort: (effort: EffortId) => void
  // Runtime-only: per node, the y-offset (flow px from the node top) of each
  // message that an edge anchors on — measured from the DOM by ChatNodeView so
  // fork edges can attach to the message itself rather than the node center.
  anchorOffsets: Record<string, Record<string, number>>
  setAnchorOffsets: (nodeId: string, offsets: Record<string, number>) => void
  // Runtime-only: node awaiting delete confirmation (the modal is open for it).
  pendingDeleteId: string | null
  // Runtime-only: a new-node ghost is stuck to the cursor, waiting for a
  // placement click on the canvas (armed by the toolbar buttons / C / N / F / L).
  placing: 'chat' | 'note' | 'file' | 'link' | null
  setPlacing: (kind: 'chat' | 'note' | 'file' | 'link' | null) => void
  // Runtime-only: the picked image riding the file-placement ghost.
  pendingFile: PendingFile | null
  // Open the image picker; on a pick, arm file placement with the image ghost.
  startFilePlacement: () => Promise<void>
  // Runtime-only: click-to-connect. A tap on a note's, file's, or link's circle
  // arms it; the pending context arrow follows the cursor (ContextConnectOverlay)
  // until a click on a chat commits the edge — or any other click / Esc cancels.
  ctxConnectSource: string | null
  setCtxConnectSource: (id: string | null) => void
  // Runtime-only: the node currently wrapped in transform mode — a dashed,
  // colored temporary frame with a one-shot composer floating above it (its
  // instruction runs deriveNote). One node at a time; Esc / the × clears it.
  transforming: string | null
  setTransforming: (id: string | null) => void
  // Runtime-only: the node open out of its canvas card — either right-docked
  // ('panel', the canvas stays live beside it) or covering the window ('full').
  // Both render the same body; only the container's size differs, so flipping
  // modes never remounts a webview. The card shows a stub while open — a
  // webview can only be mounted once. Esc or a chip closes it; the frame is
  // never touched.
  expanded: { id: string; mode: PanelMode } | null
  // A browsing session in the side panel: the ordered link tabs opened by
  // clicking links in chat/note bodies. expanded.id is whichever is active
  // (mounted); the rest are stubs on the canvas. Empty for a normal single-
  // node panel (a chat/note/file opened via its own chip). Closing the panel
  // clears it; the tabs stay as separate cards on the canvas.
  panelTabs: string[]
  expandNode: (id: string, mode?: PanelMode) => void
  collapseExpanded: () => void
  // Drop one tab from the strip (its node stays on the canvas). If it was the
  // active tab, focus drops to a neighbor — or the panel closes if it was last.
  closePanelTab: (id: string) => void
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
  // With a URL (a paste) the tab is born showing the page; without one it
  // opens on the search-or-link input.
  addLinkAt: (position: { x: number; y: number }, url?: string) => LinkNode
  // A link clicked inside a chat/note body: materialize a tab next to the
  // source node and open it in the half-sheet panel, so the page reads beside
  // the work instead of hijacking the window. Returns the tab's node id.
  openLinkInPanel: (url: string, sourceId?: string) => string
  // Commit the URL a tab embeds; an untitled node takes the hostname.
  setLinkUrl: (id: string, url: string) => void
  // The tab's guest navigated — track its current URL (frame untouched).
  syncTabUrl: (id: string, url: string) => void
  // OS drag-and-drop: place each dropped image/PDF as a file node centered on
  // the drop point (cascading when several arrive together) and attach it.
  addDroppedFiles: (point: { x: number; y: number }, picked: ChosenFile[]) => Promise<void>
  clearFocusDraft: (id: string) => void
  setDraft: (id: string, draft: string) => void
  setColor: (id: string, color: string) => void
  setTitle: (id: string, title: string) => void
  commitNoteTitle: (id: string) => Promise<void>
  setNoteContent: (id: string, content: string) => void
  // Version pager: view a past snapshot read-only (undefined = live content),
  // or bring one back to the front (snapshots current first, never destructive).
  setViewVersion: (id: string, index: number | undefined) => void
  restoreVersion: (id: string, index: number) => Promise<void>
  // Pin/unpin a note into the project memory index. Pinning kicks off a
  // description if the note has content and none yet.
  togglePin: (id: string) => void
  // Debounced regeneration of a pinned note's 1-3 sentence index description
  // (Haiku one-shot). A no-op for unpinned or empty notes.
  scheduleDescribe: (id: string) => void
  // Apply an agent's on-disk edit that was parked behind the unsaved-edits
  // guard (the "Reload" action on a note).
  reloadExternalEdit: (id: string) => void
  send: (id: string) => void
  retry: (id: string) => void
  sendNote: (id: string) => Promise<void>
  toggleResearch: (id: string) => void
  respondPermission: (id: string, requestId: string, allow: boolean) => void
  forkChat: (nodeId: string) => string | null
  // Derive a fresh note from any node + an instruction: spawn a note to the
  // right wired back by a 'derive' edge, then run an editing turn grounded in
  // the source (a chat forks its session; a note/file/link rides as context).
  // With inPlace (note sources only), skip the spawn and rewrite the source
  // note itself — the turn lands as a new version in its own history.
  deriveNote: (sourceId: string, instruction: string, inPlace?: boolean) => Promise<string | null>
  // Context edges: a note, file, or link feeding a chat's system prompt
  // (note/file/link → chat only).
  addContextEdge: (sourceId: string, chatId: string) => void
  removeContextEdge: (edgeId: string) => void
  // Wire a chat → note so the chat can read AND write that note.
  addOutputEdge: (chatId: string, noteId: string) => void
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

// Thinking effort is an app-wide preference too — same localStorage home.
const EFFORT_STORAGE_KEY = 'bee-claude:effort'
function loadEffort(): EffortId {
  const saved = localStorage.getItem(EFFORT_STORAGE_KEY)
  return EFFORT_OPTIONS.some((e) => e.id === saved) ? (saved as EffortId) : DEFAULT_EFFORT
}

let saveTimer: ReturnType<typeof setTimeout> | undefined
// Debounced per-note autosave of live content (keystrokes → the note's file).
const noteSaveTimers = new Map<string, ReturnType<typeof setTimeout>>()
// Debounced per-note index-description regeneration (pinned notes only).
const describeTimers = new Map<string, ReturnType<typeof setTimeout>>()
// Researchers running right now: `${leadNodeId}:${toolUseId}` → {parentId, msgId} in lead.
// Mid-turn only, so it lives outside the store (no re-renders, never persisted).
const researchChildren = new Map<string, { parentId: string; msgId: string }>()
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
            ? {
                kind: 'note' as const,
                ...(n.data.pinned ? { pinned: true } : {}),
                ...(n.data.description ? { description: n.data.description } : {}),
                ...(n.data.system ? { system: n.data.system } : {})
              }
            : isFile(n)
              ? { kind: 'file' as const, ...(n.data.file ? { file: n.data.file } : {}) }
              : isLink(n)
                ? { kind: 'link' as const, ...(n.data.url ? { url: n.data.url } : {}) }
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
          ...(!isFile(n) && !isLink(n) && n.data.sessionId ? { sessionId: n.data.sessionId } : {}),
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
      pendingFile: null,
      transforming: null,
      expanded: null,
      panelTabs: []
    })
    const vp = await get().load()
    return vp ?? { x: 0, y: 0, zoom: 1 } // fresh folder: reset the view
  }

  const anyStreaming = (): boolean => get().nodes.some((n) => n.data.status === 'streaming')

  // The persistent CLAUDE.md node refuses deletion, rename, and pinning.
  const isClaudeMd = (id: string): boolean => {
    const n = get().nodes.find((x) => x.id === id)
    return !!n && isNote(n) && n.data.system === 'claudeMd'
  }

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

  // Notes this chat may write, wired by output edges (chat → note). Their
  // content rides the system prompt like contextNotes; main also permits and
  // mirrors edits to their files.
  const outputNotesFor = (id: string): { id: string; title: string; content: string }[] =>
    get()
      .edges.filter((e) => e.kind === 'output' && e.source === id)
      .flatMap((e) => {
        const tgt = get().nodes.find((n) => n.id === e.target)
        return tgt && isNote(tgt)
          ? [{ id: tgt.id, title: tgt.data.title || 'Untitled note', content: tgt.data.content }]
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

  // Links wired to a chat: each send reads the tab's rendered page out of its
  // live <webview> guest as markdown — what the user sees is what the model
  // gets, so bot walls and JS-only pages that defeat a plain fetch don't
  // matter. A link whose guest can't be read (tab minimized, page hung) goes
  // along as a bare URL and main falls back to the WebFetch instruction.
  // A link whose URL hasn't been committed yet sits out.
  const contextLinksFor = (id: string): ContextLink[] =>
    get()
      .edges.filter((e) => e.kind === 'context' && e.target === id)
      .flatMap((e) => {
        const src = get().nodes.find((n) => n.id === e.source)
        return src && isLink(src) && src.data.url
          ? [
              {
                id: src.id,
                title: src.data.title || hostTitle(src.data.url) || 'Untitled link',
                url: src.data.url
              }
            ]
          : []
      })

  const withPageContent = (links: ContextLink[]): Promise<ContextLink[]> =>
    Promise.all(
      links.map(async (l) => {
        const content = await extractPageMarkdown(l.id, l.url)
        return content ? { ...l, content } : l
      })
    )

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

  // Guarantee the one persistent CLAUDE.md node is present. A no-op when it
  // already is (the common reload path — main injects it into the doc for
  // pre-feature canvases). When absent (a brand-new folder), synthesize it with
  // the fixed id and ensure its root file exists.
  const ensureClaudeMd = (nodes: CanvasNode[]): CanvasNode[] => {
    if (nodes.some((n) => isNote(n) && n.data.system === 'claudeMd')) return nodes
    const node: NoteNode = {
      ...makeNoteNode(CLAUDE_MD_POS, { title: 'CLAUDE.md', system: 'claudeMd' }),
      id: CLAUDE_MD_ID
    }
    void window.api.note.create(CLAUDE_MD_ID)
    return [node, ...nodes]
  }

  return {
    nodes: [],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
    loaded: false,
    folder: null,
    model: loadModel(),
    effort: loadEffort(),
    anchorOffsets: {},
    pendingDeleteId: null,
    placing: null,
    pendingFile: null,
    ctxConnectSource: null,
    transforming: null,
    expanded: null,
    panelTabs: [],

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

    setTransforming: (id) => set({ transforming: id }),

    setModel: (model) => {
      set({ model })
      localStorage.setItem(MODEL_STORAGE_KEY, model)
    },

    setEffort: (effort) => {
      set({ effort })
      localStorage.setItem(EFFORT_STORAGE_KEY, effort)
    },

    expandNode: (id, mode = 'panel') => {
      if (!get().nodes.some((n) => n.id === id)) return
      // Switching to a tab already in the browsing strip keeps the strip;
      // expanding anything else starts a fresh single-node panel.
      set((s) => ({
        expanded: { id, mode },
        ...(s.panelTabs.includes(id) ? {} : { panelTabs: [] })
      }))
    },

    collapseExpanded: () => set({ expanded: null, panelTabs: [] }),

    closePanelTab: (id) => {
      set((s) => {
        const remaining = s.panelTabs.filter((t) => t !== id)
        if (s.expanded?.id !== id) return { panelTabs: remaining }
        // Closing the active tab: fall to its right neighbor, else its left.
        const at = s.panelTabs.indexOf(id)
        const next = remaining[at] ?? remaining[at - 1]
        return next
          ? { panelTabs: remaining, expanded: { id: next, mode: s.expanded.mode } }
          : { panelTabs: [], expanded: null }
      })
    },

    requestDelete: (id) => {
      if (isClaudeMd(id)) return // CLAUDE.md is permanent
      set({ pendingDeleteId: id })
    },

    cancelDelete: () => set({ pendingDeleteId: null }),

    deleteChat: (id, cascade) => {
      const byId = new Map(get().nodes.map((n) => [n.id, n]))
      const doomed = cascade ? forkSubtree(get().edges, id) : new Set([id])
      set((s) => ({
        pendingDeleteId: null,
        // deleting the panel-open node closes the panel with it
        ...(s.expanded && doomed.has(s.expanded.id) ? { expanded: null } : {}),
        // and drops any deleted tabs from the browsing strip
        ...(s.panelTabs.some((t) => doomed.has(t))
          ? { panelTabs: s.panelTabs.filter((t) => !doomed.has(t)) }
          : {}),
        nodes: s.nodes.filter((n) => !doomed.has(n.id)),
        edges: s.edges.filter((e) => !doomed.has(e.source) && !doomed.has(e.target))
      }))
      for (const nodeId of doomed) {
        const node = byId.get(nodeId)
        if (node && isNote(node)) void window.api.note.delete(nodeId)
        else if (node && (isFile(node) || isLink(node))) {
          // nothing on disk to clean up — the node is just a pin
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

    addLinkAt: (position, url) => {
      const node = makeLinkNode(position, {
        color: nextColor(),
        ...(url ? { url, title: hostTitle(url) } : {})
      })
      if (url) node.height = LINK_FRAME.height
      return adopt(node)
    },

    openLinkInPanel: (url, sourceId) => {
      // Drop the tab just right of the node the link was clicked in (so its
      // canvas card has a sensible home), or at the viewport's top-left when
      // there's no source. adopt doesn't dodge overlaps, so cascade each new
      // tab of the session down-right of the last — without it, several links
      // from one chat would stack exactly, hidden behind each other once the
      // panel closes. The tab opens straight into the panel regardless; the
      // cascade only matters for where its card lands on the canvas.
      const src = sourceId ? get().nodes.find((n) => n.id === sourceId) : undefined
      const vp = get().viewport
      const step = get().panelTabs.length * GAP
      const base = src
        ? { x: src.position.x + (src.width ?? NODE_W) + GAP, y: src.position.y }
        : { x: (-vp.x + 80) / vp.zoom, y: (-vp.y + 80) / vp.zoom }
      const position = { x: base.x + step, y: base.y + step }
      const node = get().addLinkAt(position, url)
      // Append to the browsing strip and bring the fresh tab to the front —
      // a clicked link opens in the foreground, like a browser.
      set((s) => ({
        panelTabs: [...s.panelTabs.filter((t) => t !== node.id), node.id],
        expanded: { id: node.id, mode: 'panel' }
      }))
      return node.id
    },

    setLinkUrl: (id, url) => {
      const node = get().nodes.find((n) => n.id === id)
      if (!node || !isLink(node)) return
      const title = node.data.title || hostTitle(url)
      // The committed page opens at the full browser-card height.
      set((s) => ({
        nodes: s.nodes.map((n) =>
          n.id === id
            ? ({
                ...n,
                height: Math.max(n.height ?? 0, LINK_FRAME.height),
                data: { ...n.data, url, title }
              } as CanvasNode)
            : n
        )
      }))
      persist()
    },

    // A result click, an address-bar search, a redirect — keep data.url on
    // the page actually showing (it's what a context edge hands to a chat,
    // and where the tab reopens on canvas load). An auto host title follows
    // the page along; a user-typed title stays put.
    syncTabUrl: (id, url) => {
      const node = get().nodes.find((n) => n.id === id)
      if (!node || !isLink(node) || !url || node.data.url === url) return
      const auto = !node.data.title || node.data.title === hostTitle(node.data.url ?? '')
      const title = auto ? hostTitle(url) || node.data.title : node.data.title
      set((s) => ({
        nodes: s.nodes.map((n) =>
          n.id === id ? ({ ...n, data: { ...n.data, url, title } } as CanvasNode) : n
        )
      }))
      persist()
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
      if (isClaudeMd(id)) return // its filename is fixed; never rename
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
      // A pinned note's index blurb tracks its content (debounced inside).
      const node = get().nodes.find((n) => n.id === id)
      if (node && isNote(node) && node.data.pinned) get().scheduleDescribe(id)
    },

    setViewVersion: (id, index) => patchData(id, { viewVersion: index }),

    restoreVersion: async (id, index) => {
      const node = get().nodes.find((n) => n.id === id)
      if (!node || !isNote(node) || node.data.status === 'streaming') return
      // Any pending keystrokes must reach disk first — main snapshots the live
      // file before overwriting it, and that snapshot has to be current.
      await flushNoteSave(id)
      const res = await window.api.note.restore(id, index)
      if (res) {
        patchData(id, {
          content: res.content,
          versions: res.versions,
          viewVersion: undefined,
          updatedAt: Date.now()
        })
        persist()
        get().scheduleDescribe(id)
      }
    },

    togglePin: (id) => {
      if (isClaudeMd(id)) return // already always-in-context; not a memory pin
      const node = get().nodes.find((n) => n.id === id)
      if (!node || !isNote(node)) return
      const pinned = !node.data.pinned
      patchData(id, { pinned })
      persist() // pin state + the regenerated MEMORY.md ride the canvas save
      // First pin of a note that already has content but no blurb: describe it
      // now so the index line isn't bare.
      if (pinned && node.data.content.trim() && !node.data.description) {
        get().scheduleDescribe(id)
      }
    },

    scheduleDescribe: (id) => {
      const existing = describeTimers.get(id)
      if (existing) clearTimeout(existing)
      describeTimers.set(
        id,
        setTimeout(() => {
          describeTimers.delete(id)
          const node = get().nodes.find((n) => n.id === id)
          if (!node || !isNote(node) || !node.data.pinned) return
          const content = node.data.content.trim()
          if (!content) return
          void window.api.note.describe(content).then((description) => {
            if (!description) return
            const cur = get().nodes.find((n) => n.id === id)
            // The note may have been unpinned or deleted while Haiku ran.
            if (cur && isNote(cur) && cur.data.pinned) {
              patchData(id, { description })
              persist()
            }
          })
        }, 1500)
      )
    },

    reloadExternalEdit: (id) => {
      const node = get().nodes.find((n) => n.id === id)
      if (!node || !isNote(node) || !node.data.externalEdit) return
      patchData(id, {
        content: node.data.externalEdit.content,
        externalEdit: undefined,
        updatedAt: Date.now()
      })
      persist()
    },

    toggleResearch: (id) => {
      const node = get().nodes.find((n) => n.id === id)
      if (node && isChat(node)) patchData(id, { researchArmed: !node.data.researchArmed })
    },

    respondPermission: (id, requestId, allow) => {
      const node = get().nodes.find((n) => n.id === id)
      if (!node || isFile(node) || isLink(node)) return
      if (node.data.pendingPermission?.requestId !== requestId) return
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

    // Generalizes the old "distill chat → note": works from any node, with a
    // free-form instruction, and leaves a visible derive edge behind. A chat
    // source forks its session at the tip (full context, images, and prompt
    // cache ride along for free); a document source feeds the note turn as
    // context the same way it would feed a chat. The output is always a note.
    deriveNote: async (sourceId, instruction, inPlace = false) => {
      const source = get().nodes.find((n) => n.id === sourceId)
      const text = instruction.trim()
      if (!source || !text) return null
      // Don't fork a chat mid-stream — its tip isn't settled yet.
      if (isChat(source) && source.data.status === 'streaming') return null

      // Edit-in-place: rewrite the source note itself instead of deriving a
      // new one. The editing turn connects to the source note's own file, so
      // the prior content snapshots into its history and the rewrite lands as
      // a new version (visible via the pager) — no new node, no edge.
      if (inPlace && isNote(source)) {
        if (source.data.status === 'streaming') return null
        patchData(sourceId, {
          status: 'streaming',
          growthCap: viewportFitHeight(get().viewport.zoom),
          viewVersion: undefined, // an editing turn always lands on the live content
          updatedAt: Date.now()
        })
        void window.api.thread.send({
          nodeId: sourceId,
          text,
          model: get().model,
          effort: get().effort,
          kind: 'note',
          noteTitle: source.data.title || 'Untitled note'
        })
        return sourceId
      }

      // A chat source rides a session fork when it has a forkable tip; without
      // one (empty chat, a research transcript with no session) its transcript
      // is serialized into a context block instead.
      const chatSource = isChat(source)
      let forkFrom: ForkRef | undefined
      if (chatSource) {
        const anchor = [...source.data.messages]
          .reverse()
          .find((m) => m.role === 'assistant' && m.uuid)
        if (anchor?.uuid && source.data.sessionId) {
          forkFrom = { sessionId: source.data.sessionId, messageUuid: anchor.uuid }
        }
      }

      // Right of the source, same level — deliberately plain placement
      // (overlapping a neighbor is fine). Spawned unselected: sharing a
      // selection with the source would make React Flow drag them as a unit.
      const p = boxOf(source)
      const node = makeNoteNode(
        { x: p.x + p.w + DERIVE_GAP, y: p.y },
        {
          // Left untitled: the note shows a "…" placeholder while it streams and
          // gets a real title from its content once the turn lands (see the
          // thread-event handler) — never the raw instruction.
          title: '',
          // The note wears the wrapper's color — a palette color chosen to
          // differ from the source, so it reads as derived-from but distinct.
          color: contrastColorId(source.data.color),
          status: 'streaming',
          growthCap: viewportFitHeight(get().viewport.zoom),
          updatedAt: Date.now()
        }
      )
      set((st) => ({
        nodes: [...st.nodes, node],
        edges: [
          ...st.edges,
          { id: uid(), source: sourceId, target: node.id, kind: 'derive' as const }
        ]
      }))
      persist()

      // The editing turn writes by node id, so the file can stay "Untitled"
      // (create allocates it, suffixing to dodge collisions); once the turn
      // finishes, generateTitle renames it to match the generated title.
      await window.api.note.create(node.id)
      const noteTitle = 'Untitled note'

      // Build the document feed (a chat source rides forkFrom instead).
      const contextNotes: { id: string; title: string; content: string }[] = []
      const contextFiles: ContextFile[] = []
      if (!chatSource && isNote(source)) {
        contextNotes.push({
          id: source.id,
          title: source.data.title || 'Untitled note',
          content: source.data.content
        })
      } else if (!chatSource && isFile(source) && source.data.file) {
        contextFiles.push({
          id: source.id,
          title:
            source.data.title || (source.data.kind === 'pdf' ? 'Untitled PDF' : 'Untitled image'),
          file: source.data.file,
          isNew: true
        })
      } else if (chatSource && !forkFrom) {
        // No forkable session — hand the transcript over as a context block.
        const transcript = source.data.messages
          .filter((m) => m.text)
          .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.text}`)
          .join('\n\n')
        if (transcript) {
          contextNotes.push({
            id: source.id,
            title: source.data.title || 'Chat',
            content: transcript
          })
        }
      }

      void (async () => {
        const contextLinks =
          !chatSource && isLink(source) && source.data.url
            ? await withPageContent([
                {
                  id: source.id,
                  title: source.data.title || hostTitle(source.data.url) || 'Untitled link',
                  url: source.data.url
                }
              ])
            : []
        void window.api.thread.send({
          nodeId: node.id,
          text,
          model: get().model,
          effort: get().effort,
          kind: 'note',
          noteTitle,
          ...(forkFrom ? { forkFrom } : {}),
          ...(contextNotes.length > 0 ? { contextNotes } : {}),
          ...(contextFiles.length > 0 ? { contextFiles } : {}),
          ...(contextLinks.length > 0 ? { contextLinks } : {})
        })
      })()
      return node.id
    },

    addContextEdge: (sourceId, chatId) => {
      const s = get()
      const src = s.nodes.find((n) => n.id === sourceId)
      const tgt = s.nodes.find((n) => n.id === chatId)
      if (!src || !tgt || !(isNote(src) || isFile(src) || isLink(src)) || !isChat(tgt)) return
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

    addOutputEdge: (chatId, noteId) => {
      const s = get()
      const src = s.nodes.find((n) => n.id === chatId)
      const tgt = s.nodes.find((n) => n.id === noteId)
      // chat → note only; research chats can't edit, so they can't drive a note
      if (!src || !tgt || !isChat(src) || src.data.kind === 'research' || !isNote(tgt)) return
      if (s.edges.some((e) => e.kind === 'output' && e.source === chatId && e.target === noteId))
        return // already connected
      set((st) => ({
        edges: [...st.edges, { id: uid(), source: chatId, target: noteId, kind: 'output' }]
      }))
      persist()
    },

    discardNode: (id) => {
      if (isClaudeMd(id)) return // permanent — never discarded as a blank note
      const node = get().nodes.find((n) => n.id === id)
      set((s) => ({
        ...(s.expanded?.id === id ? { expanded: null } : {}),
        ...(s.panelTabs.includes(id) ? { panelTabs: s.panelTabs.filter((t) => t !== id) } : {}),
        nodes: s.nodes.filter((n) => n.id !== id),
        edges: s.edges.filter((e) => e.source !== id && e.target !== id)
      }))
      if (node && isNote(node)) void window.api.note.delete(id)
      else if (node && (isFile(node) || isLink(node))) {
        // nothing on disk to clean up
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
                  // title is left as-is: an unnamed chat shows a "…" placeholder
                  // and gets a real title from its content once the turn lands
                  // (see the thread-event handler) — never the raw prompt.
                  researchArmed: false // one-shot: research applies to this send only
                }
              } as CanvasNode)
            : n
        )
      }))
      persist() // title may have changed
      persistThread(id) // the user message is part of the durable transcript now

      const contextNotes = contextNotesFor(id)
      const outputNotes = outputNotesFor(id)
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
      // Reading the tabs' rendered pages is async — the composer already
      // cleared and the bubble is streaming-pending, so the await is invisible
      // (and capped by pageText's extraction timeout).
      void (async () => {
        const contextLinks = await withPageContent(contextLinksFor(id))
        void window.api.thread.send({
          nodeId: id,
          text,
          sessionId: node.data.sessionId,
          model: get().model,
          effort: get().effort,
          // first send of a forked node: fork the parent session at the anchor
          ...(!node.data.sessionId && node.data.forkOf ? { forkFrom: node.data.forkOf } : {}),
          ...(node.data.researchArmed ? { research: true } : {}),
          ...(contextNotes.length > 0 ? { contextNotes } : {}),
          ...(contextFiles.length > 0 ? { contextFiles } : {}),
          ...(contextLinks.length > 0 ? { contextLinks } : {}),
          ...(outputNotes.length > 0 ? { outputNotes } : {})
        })
      })()
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
      const outputNotes = outputNotesFor(id)
      const injected = new Set(node.data.injectedImages ?? [])
      const contextFiles = contextFilesFor(id).map((f) => ({
        ...f,
        isNew: !injected.has(f.id)
      }))
      const newFileIds = contextFiles.filter((f) => f.isNew).map((f) => f.id)
      if (newFileIds.length > 0) pendingFileInjections.set(id, newFileIds)
      else pendingFileInjections.delete(id)
      void (async () => {
        const contextLinks = await withPageContent(contextLinksFor(id))
        void window.api.thread.send({
          nodeId: id,
          text: lastUser.text,
          sessionId: node.data.sessionId,
          model: get().model,
          effort: get().effort,
          // the failed turn may have been a fork's first send — fork again
          ...(!node.data.sessionId && node.data.forkOf ? { forkFrom: node.data.forkOf } : {}),
          ...(contextNotes.length > 0 ? { contextNotes } : {}),
          ...(contextFiles.length > 0 ? { contextFiles } : {}),
          ...(contextLinks.length > 0 ? { contextLinks } : {}),
          ...(outputNotes.length > 0 ? { outputNotes } : {})
        })
      })()
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
                  viewVersion: undefined, // an editing turn always lands on the live content
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
        effort: get().effort,
        kind: 'note',
        noteTitle: node.data.title
      })
    },

    load: async () => {
      const doc = await window.api.canvas.load()
      if (!doc) {
        // Brand-new folder, no canvas.json yet — still give it its CLAUDE.md.
        set({ loaded: true, nodes: ensureClaudeMd([]) })
        get().persistSoon()
        return null
      }
      // Heights saved on a bigger screen may not fit this one — clamp on the way in.
      const cap = viewportFitHeight(doc.viewport.zoom)
      set({
        loaded: true,
        viewport: doc.viewport,
        edges: doc.edges ?? [],
        nodes: ensureClaudeMd(
          doc.nodes.map((p) => {
            const frame = {
              id: p.id,
              width: p.width,
              ...(p.height != null && !p.minimized ? { height: Math.min(p.height, cap) } : {})
            }
            const savedHeight =
              p.minimized && p.height != null ? Math.min(p.height, cap) : undefined
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
            if (p.kind === 'link') {
              const node = makeLinkNode(p.position, {
                title: p.title,
                color: p.color,
                url: p.url,
                minimized: p.minimized ?? false,
                ...(p.minimized && p.height != null ? { savedHeight: p.height } : {})
              })
              return {
                ...node,
                id: p.id,
                width: p.width,
                // minimized links collapse to the title row (no explicit height)
                height: p.height != null && !p.minimized ? p.height : undefined
              }
            }
            if (p.kind === 'note') {
              return {
                ...makeNoteNode(p.position, {
                  title: p.title,
                  color: p.color,
                  content: p.content ?? '',
                  versions: p.noteVersions ?? [],
                  ...(p.pinned ? { pinned: true } : {}),
                  ...(p.description ? { description: p.description } : {}),
                  ...(p.system ? { system: p.system } : {}),
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
        )
      })
      return doc.viewport
    }
  }
})

// Fallback title from a block of text — the first non-empty line, stripped of
// leading markdown heading/bullet markers and capped. Used when the one-shot
// title turn fails, so a finished node never sits on "…" forever.
function titleFromText(text: string): string {
  const line =
    text
      .split('\n')
      .map((l) => l.trim())
      .find(Boolean) ?? ''
  return line
    .replace(/^#+\s*/, '')
    .replace(/^[-*+]\s+/, '')
    .slice(0, 60)
    .trim()
}

// Name a node in the background once its first turn lands: ask Haiku for a
// concise title from `source` (a chat's opening exchange or a note's content)
// and install it — unless the user has named the node in the meantime, whose
// title always wins. A failed turn falls back to `fallback`; for notes the file
// is renamed to match.
function generateTitle(
  nodeId: string,
  source: string,
  fallback: string,
  isNoteNode: boolean
): void {
  // Install the first answer we get and ignore the rest — the title turn might
  // resolve, reject, or hang (a stranded Haiku query would otherwise leave the
  // node on its "…" placeholder forever), so a timeout backs it with `fallback`.
  let done = false
  const install = (title: string | null): void => {
    if (done) return
    done = true
    const next = title || fallback
    if (!next) return
    const cur = useCanvasStore.getState().nodes.find((n) => n.id === nodeId)
    if (!cur || cur.data.title) return // user renamed it first — their title wins
    useCanvasStore.getState().setTitle(nodeId, next)
    if (isNoteNode) void useCanvasStore.getState().commitNoteTitle(nodeId)
  }
  window.api.thread.title(source).then(install, () => install(null))
  setTimeout(() => install(null), 15000)
}

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
    // The lead called the Agent tool — show an inline status chip in the parent chat.
    const msgId = uid()
    researchChildren.set(`${event.nodeId}:${event.toolUseId}`, {
      parentId: event.nodeId,
      msgId
    })
    patch(event.nodeId, (node) => {
      if (!isChat(node)) return {}
      return {
        messages: [
          ...node.data.messages,
          { id: msgId, role: 'assistant' as const, text: event.description, kind: 'research-spawn' as const }
        ]
      }
    })
  } else if (event.type === 'childDelta') {
    // Researcher content stays inside the lead's turn — drop streaming deltas.
  } else if (event.type === 'childDone') {
    const key = `${event.nodeId}:${event.toolUseId}`
    const entry = researchChildren.get(key)
    researchChildren.delete(key)
    if (entry) {
      patch(entry.parentId, (node) => {
        if (!isChat(node)) return {}
        return {
          messages: node.data.messages.map((m) =>
            m.id === entry.msgId ? { ...m, kind: 'research-done' as const } : m
          )
        }
      })
    }
  } else if (event.type === 'note-content') {
    patch(event.nodeId, (node) =>
      isNote(node)
        ? { content: event.content, ...(event.versions ? { versions: event.versions } : {}) }
        : {}
    )
  } else if (event.type === 'note-external-edit') {
    // A chat just edited this note's file. If the user has unsaved edits in it
    // (a pending autosave), park the new content behind a "Reload" prompt
    // instead of clobbering their work; otherwise adopt it and refresh history.
    const store = useCanvasStore.getState()
    const node = store.nodes.find((n) => n.id === event.nodeId)
    if (!node || !isNote(node)) return
    if (noteSaveTimers.has(event.nodeId) || node.data.status === 'streaming') {
      patch(event.nodeId, () => ({ externalEdit: { content: event.content } }))
    } else {
      patch(event.nodeId, () => ({
        content: event.content,
        externalEdit: undefined,
        updatedAt: Date.now(),
        ...(event.versions ? { versions: event.versions } : {})
      }))
      store.persistSoon()
      if (node.data.pinned) store.scheduleDescribe(event.nodeId)
    }
  } else if (event.type === 'permission') {
    patch(event.nodeId, () => ({ pendingPermission: event.request }))
  } else if (event.type === 'permission-resolved') {
    patch(event.nodeId, (node) =>
      !isFile(node) && !isLink(node) && node.data.pendingPermission?.requestId === event.requestId
        ? { pendingPermission: undefined }
        : {}
    )
  } else if (event.type === 'done') {
    // Safety sweep: a turn that errored mid-research leaves no childDone — settle any
    // still-pending inline research chips.
    for (const [key, entry] of researchChildren) {
      if (key.startsWith(`${event.nodeId}:`)) {
        researchChildren.delete(key)
        patch(entry.parentId, (node) => {
          if (!isChat(node)) return {}
          return {
            messages: node.data.messages.map((m) =>
              m.id === entry.msgId ? { ...m, kind: 'research-done' as const } : m
            )
          }
        })
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
          viewVersion: undefined, // land back on the live content after the turn
          ...(event.usage ? { lastUsage: event.usage } : {}),
          // adopt the turn's settled content + version history
          ...(event.note
            ? {
                content: event.note.content,
                ...(event.note.versions ? { versions: event.note.versions } : {})
              }
            : {}),
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

    // An editing turn changed a pinned note — refresh its index description.
    if (event.ok && event.note) {
      const node = useCanvasStore.getState().nodes.find((n) => n.id === event.nodeId)
      if (node && isNote(node) && node.data.pinned) {
        useCanvasStore.getState().scheduleDescribe(event.nodeId)
      }
    }

    // A turn landed on a still-unnamed node: name it from a one-shot Haiku turn
    // in the background — a chat from its opening exchange, a note from its
    // content. Until that returns the node shows a "…" placeholder; a user
    // rename (before or during) always wins.
    if (event.ok) {
      const node = useCanvasStore.getState().nodes.find((n) => n.id === event.nodeId)
      if (node && !node.data.title) {
        if (isChat(node) && node.data.kind !== 'research') {
          const firstUser = node.data.messages.find((m) => m.role === 'user')
          const reply = node.data.messages.find((m) => m.role === 'assistant' && m.text)
          if (firstUser && reply?.text) {
            const conversation =
              `User: ${firstUser.text.slice(0, 1500)}\n\n` +
              `Assistant: ${reply.text.slice(0, 1500)}`
            generateTitle(event.nodeId, conversation, titleFromText(reply.text), false)
          }
        } else if (isNote(node) && node.data.content) {
          generateTitle(
            event.nodeId,
            node.data.content.slice(0, 3000),
            titleFromText(node.data.content),
            true
          )
        }
      }
      // Output notes a chat writes via an output port receive their content
      // through note-content events but never a turn-complete of their own —
      // name them off the chat's completed turn so they don't strand on "…".
      if (node && isChat(node)) {
        const store = useCanvasStore.getState()
        for (const edge of store.edges) {
          if (edge.kind !== 'output' || edge.source !== event.nodeId) continue
          const out = store.nodes.find((n) => n.id === edge.target)
          if (out && isNote(out) && !out.data.title && out.data.content) {
            generateTitle(
              out.id,
              out.data.content.slice(0, 3000),
              titleFromText(out.data.content),
              true
            )
          }
        }
      }
    }
  }
})
