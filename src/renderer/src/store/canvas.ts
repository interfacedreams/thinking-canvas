import { create } from 'zustand'
import { applyNodeChanges, type Node, type NodeChange, type Viewport } from '@xyflow/react'
import { DEFAULT_EFFORT, DEFAULT_MODEL, EFFORT_OPTIONS, MODEL_OPTIONS } from '../../../shared/types'
import type {
  CanvasDoc,
  ChosenFile,
  ComputerTarget,
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
import { extractPageMarkdown, guestWebContentsId } from '../lib/pageText'
import { useToastStore } from './toast'

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
  // Scale the auto-grow ceiling to the actual window height — no fixed cap, so
  // a tall monitor lets chat/note nodes grow taller before they start to scroll.
  const h = (window.innerHeight * 0.85) / Math.max(zoom, 1)
  return Math.round(Math.max(MIN_GROW_H, h))
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
  // Pinned into the project memory index — every new chat sees this chat's
  // transcript clip in MEMORY.md and can read it on demand. The clip is
  // re-snapshotted as the conversation grows.
  pinned?: boolean
  // 1-3 sentence index description (Haiku-generated, cached), same as a note's.
  // The MEMORY.md line for a pinned chat uses it.
  description?: string
  forkOf?: ForkRef // pending fork; consumed by the first send, then cleared
  focusDraft?: boolean // autofocus the composer when the node mounts
  lastUsage?: TurnUsage // tokens/cost of the most recent turn
  lastError?: string // what the failed turn said; shown while status === 'error'
  pendingPermission?: PermissionRequest // tool call awaiting the user's Allow/Deny
  // Research children are display-only researcher transcripts: no composer,
  // no forking, no session of their own (they ran inside the lead's session).
  kind?: 'research'
  researchArmed?: boolean // composer toggle: the next send runs in research mode
  // Composer toggle: sends drive a connected browser tab (computer use).
  // Sticky — browsing is a conversation-long mode, unlike one-shot research.
  computerArmed?: boolean
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
  // Runtime-only: a background title turn is in flight (kicked off after an AI
  // turn lands on an unnamed note). Drives the pulsing "…" placeholder; cleared
  // when the title installs. A manually-edited note never sets this, so it
  // shows "Untitled note" instead of stranding on the placeholder forever.
  titlePending?: boolean
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
  pinned?: boolean // in the project memory index (MEMORY.md); agent Reads it on demand
  description?: string // 1-3 sentence index blurb (vision Haiku, cached); see NoteData
  minimized: boolean
  savedHeight?: number
  updatedAt?: number // never stamped (files don't sit in the sidebar); declared so CanvasNode data reads uniformly
  [key: string]: unknown
}

export interface LinkData {
  title: string
  color?: string
  url?: string // empty until the user commits one — the body shows the URL input
  // Runtime-only: a computer-use turn is driving this tab right now — the card
  // shows a "Claude is browsing" badge and its drive wire animates. Set on the
  // turn's first computer action, cleared when the turn settles.
  driven?: boolean
  pinned?: boolean // in memory: its page is clipped to .canvas/clips/<id>.md
  description?: string // 1-3 sentence index blurb of the clipped page (cached)
  minimized: boolean
  savedHeight?: number
  updatedAt?: number // never stamped (links don't sit in the sidebar); declared so CanvasNode data reads uniformly
  [key: string]: unknown
}

export interface LabelData {
  // The label's text lives in `title` — a label has no name apart from its
  // text, and `title` already round-trips through canvas.json on save/load.
  title: string
  color?: string // unused (labels have no palette); declared so CanvasNode data reads uniformly
  minimized: boolean // labels never minimize; declared so CanvasNode data reads uniformly
  savedHeight?: number // unused; declared so the union's height handling stays well-typed
  focusDraft?: boolean // autofocus into edit mode when a freshly spawned label mounts
  updatedAt?: number // never stamped (labels don't sit in the sidebar); declared for uniformity
  [key: string]: unknown
}

export type ChatNode = Node<ChatData, 'chat'>
export type NoteNode = Node<NoteData, 'note'>
export type FileNode = Node<FileData, 'file'>
export type LinkNode = Node<LinkData, 'link'>
export type LabelNode = Node<LabelData, 'label'>
export type CanvasNode = ChatNode | NoteNode | FileNode | LinkNode | LabelNode

// How a node is opened out of its card: docked to the right ('panel') or
// covering the window ('full'). See CanvasState.expanded.
export type PanelMode = 'panel' | 'full'

export const isChat = (n: CanvasNode): n is ChatNode => n.type === 'chat'
export const isNote = (n: CanvasNode): n is NoteNode => n.type === 'note'
export const isFile = (n: CanvasNode): n is FileNode => n.type === 'file'
export const isLink = (n: CanvasNode): n is LinkNode => n.type === 'link'
export const isLabel = (n: CanvasNode): n is LabelNode => n.type === 'label'

// A pinned chat's transcript, dumped to markdown for its memory clip. Empty
// (placeholder) messages are skipped so the clip never carries blank turns.
export const chatTranscript = (messages: Message[]): string =>
  messages
    .filter((m) => m.text.trim())
    .map((m) => `## ${m.role === 'user' ? 'User' : 'Assistant'}\n\n${m.text.trim()}`)
    .join('\n\n')

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

// A label is born as a small box; the user resizes it to drive wrapping and the
// auto-fit font. The whole box is its drag surface, so it sets no dragHandle.
export const LABEL_FRAME = { width: 220, height: 90 }
export const MIN_LABEL_W = 80
export const MIN_LABEL_H = 40

function makeLabelNode(
  position: { x: number; y: number },
  partial?: Partial<LabelData>
): LabelNode {
  return {
    id: uid(),
    type: 'label',
    position,
    width: LABEL_FRAME.width,
    height: LABEL_FRAME.height,
    data: { title: '', minimized: false, ...partial }
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
 * Forks land directly to the right of their parent, level with its top — no
 * cascading and no overlap-avoidance. Siblings and anything in the way are
 * ignored: the fork may land on top of another card, and the user drags it
 * wherever they want it.
 */
function findForkSpot(parent: ChatNode): { x: number; y: number } {
  const p = boxOf(parent)
  return { x: p.x + p.w + GAP, y: p.y }
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
  placing: 'chat' | 'note' | 'file' | 'link' | 'label' | null
  setPlacing: (kind: 'chat' | 'note' | 'file' | 'link' | 'label' | null) => void
  // Runtime-only: a chat placement armed from a resource (its right-edge chat
  // knob, or C while reading a file/link in the half-sheet) carries the resource
  // id here, so the ghost shows a dimmed pending context edge and dropping it
  // wires resource → chat. Cleared with placing.
  placingContextSource: string | null
  armContextChat: (sourceId: string) => void
  // Runtime-only: the picked image riding the file-placement ghost.
  pendingFile: PendingFile | null
  // Open the image picker; on a pick, arm file placement with the image ghost.
  startFilePlacement: () => Promise<void>
  // Runtime-only: click-to-connect. A tap on a note's, file's, or link's circle
  // arms it; the pending context arrow follows the cursor (ContextConnectOverlay)
  // until a click on a chat commits the edge — or any other click / Esc cancels.
  ctxConnectSource: string | null
  setCtxConnectSource: (id: string | null) => void
  // Runtime-only: shift-click-to-connect. Holding Shift and clicking two nodes
  // in source→target order wires the edge their kinds allow (chat→note output,
  // resource→chat context). The ordered tally lives here, not in a component
  // ref, so a transparent shift-layer laid over a link's <webview> — whose page
  // clicks never reach the host DOM — can register a pick the same way the bare
  // canvas does. Whether Shift is currently held (drives that layer's mount).
  shiftPicks: string[]
  shiftHeld: boolean
  shiftConnect: (id: string) => void
  resetShiftConnect: () => void
  setShiftHeld: (held: boolean) => void
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
  expandNode: (id: string, mode?: PanelMode) => void
  collapseExpanded: () => void
  requestDelete: (id: string) => void
  cancelDelete: () => void
  deleteChat: (id: string, cascade: boolean) => void
  init: () => Promise<Viewport | null>
  chooseFolder: () => Promise<Viewport | null>
  selectFolder: (path: string) => Promise<Viewport | null>
  createFolder: (name: string, parent?: string) => Promise<Viewport | null>
  onNodesChange: (changes: NodeChange<CanvasNode>[]) => void
  setViewport: (vp: Viewport) => void
  addNodeAt: (position: { x: number; y: number }) => ChatNode
  addNoteAt: (position: { x: number; y: number }) => NoteNode
  addFileAt: (position: { x: number; y: number }) => FileNode | null
  // With a URL (a paste) the tab is born showing the page; without one it
  // opens on the search-or-link input.
  addLabelAt: (position: { x: number; y: number }) => LabelNode
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
  // Pin/unpin a resource into the project memory index. Notes and files just
  // flip the flag; a link clips its live page to a hidden markdown file first,
  // a chat clips its transcript. Pinning kicks off a 1-3 sentence description.
  togglePin: (id: string) => void
  // Re-snapshot a pinned chat's transcript clip + refresh its index blurb as the
  // conversation grows, so memory tracks the live chat. A no-op if not pinned.
  refreshChatMemory: (id: string) => void
  // Debounced regeneration of a pinned note's/chat's 1-3 sentence index
  // description (Haiku one-shot). A no-op for unpinned or empty nodes.
  scheduleDescribe: (id: string) => void
  // Apply an agent's on-disk edit that was parked behind the unsaved-edits
  // guard (the "Reload" action on a note).
  reloadExternalEdit: (id: string) => void
  send: (id: string) => void
  retry: (id: string) => void
  sendNote: (id: string) => Promise<void>
  toggleResearch: (id: string) => void
  toggleComputer: (id: string) => void
  respondPermission: (id: string, requestId: string, allow: boolean) => void
  // Fork the chat at its tip. With `at`, the new node's top-left lands there
  // (click-to-place from the output knob); without it, findForkSpot picks a slot.
  forkChat: (nodeId: string, at?: { x: number; y: number }) => string | null
  // Highlight-to-fork: spawn a chat from `sourceId` (a chat forks; a note/file/
  // link spawns a chat wired as context), auto-placed to the right, with `draft`
  // seeded into its composer — focused and waiting, nothing sent. Returns the
  // new chat's id, or null if nothing spawned.
  forkWithDraft: (sourceId: string, draft: string) => string | null
  // Derive a fresh note from any node + an instruction: spawn a note to the
  // right wired back by a 'derive' edge, then run an editing turn grounded in
  // the source (a chat forks its session; a note/file/link rides as context).
  // With inPlace (note sources only), skip the spawn and rewrite the source
  // note itself — the turn lands as a new version in its own history.
  deriveNote: (sourceId: string, instruction: string, inPlace?: boolean) => Promise<string | null>
  // Context edges: a note, file, or link feeding a chat's system prompt
  // (note/file/link → chat only).
  // THE connection creator — undirected; argument order only records how the
  // wire was drawn. Valid pairs include at least one non-research chat.
  addContextEdge: (sourceId: string, chatId: string) => void
  removeContextEdge: (edgeId: string) => void
  // Spawn a chat wired to read a note/file/link. With `center` (a flow-space
  // point), the chat is centered there — used by the panel's chat button to
  // drop it in the middle of the canvas beside the open resource. Without it,
  // the chat lands just right of the source's card. Returns the new chat's id,
  // or null if the source isn't a connectable resource.
  chatAbout: (sourceId: string, center?: { x: number; y: number }) => string | null
  // Wire a chat → note so the chat can read AND write that note.
  discardNode: (id: string) => void
  toggleMinimize: (id: string) => void
  load: () => Promise<Viewport | null>
  persistSoon: () => void
  persistThread: (id: string) => void
}

// Reads the current key, falling back to the pre-rename `bee-claude:*` key so
// a saved preference survives the app rename. (The migrated userData dir brings
// the old localStorage entries along; this picks them up the first time.)
function loadPref(key: string, legacyKey: string): string | null {
  return localStorage.getItem(key) ?? localStorage.getItem(legacyKey)
}

// Model choice is an app-wide preference, not part of any one canvas —
// it lives in localStorage rather than canvas.json.
const MODEL_STORAGE_KEY = 'thinking-canvas:model'
function loadModel(): ModelId {
  const saved = loadPref(MODEL_STORAGE_KEY, 'bee-claude:model')
  return MODEL_OPTIONS.some((m) => m.id === saved) ? (saved as ModelId) : DEFAULT_MODEL
}

// Thinking effort is an app-wide preference too — same localStorage home.
const EFFORT_STORAGE_KEY = 'thinking-canvas:effort'
function loadEffort(): EffortId {
  const saved = loadPref(EFFORT_STORAGE_KEY, 'bee-claude:effort')
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
// Tab being driven by an in-flight computer-use turn, per chat node — set on
// the turn's first computer action, cleared (and the tab's `driven` badge
// dropped) when the turn settles. Mid-turn only, so it lives outside the store.
const drivenTabs = new Map<string, string>()

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
              ? {
                  kind: 'file' as const,
                  ...(n.data.file ? { file: n.data.file } : {}),
                  ...(n.data.pinned ? { pinned: true } : {}),
                  ...(n.data.description ? { description: n.data.description } : {})
                }
              : isLink(n)
                ? {
                    kind: 'link' as const,
                    ...(n.data.url ? { url: n.data.url } : {}),
                    ...(n.data.pinned ? { pinned: true } : {}),
                    ...(n.data.description ? { description: n.data.description } : {})
                  }
                : isLabel(n)
                  ? { kind: 'label' as const }
                  : n.data.kind === 'research'
                    ? { kind: 'research' as const }
                    : {
                        // A plain chat (no `kind`) — only its memory metadata rides
                        // canvas.json; the transcript saves to its own thread file.
                        ...(n.data.pinned ? { pinned: true } : {}),
                        ...(n.data.description ? { description: n.data.description } : {})
                      }),
          position: n.position,
          width: n.width ?? NODE_W,
          ...(height != null ? { height } : {}),
          title: n.data.title,
          ...(n.data.updatedAt != null ? { updatedAt: n.data.updatedAt } : {}),
          ...(n.data.color ? { color: n.data.color } : {}),
          ...(n.data.minimized ? { minimized: true } : {}),
          ...(!isFile(n) && !isLink(n) && !isLabel(n) && n.data.sessionId
            ? { sessionId: n.data.sessionId }
            : {}),
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
      expanded: null
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

  // Serialize a chat's transcript into a plain User/Assistant block — how a
  // chat rides as context (chat → chat edge) or as a derive source that has no
  // forkable session. `clipAt` (a message id) truncates at and including that
  // message: used for a fork parent so the block stops at the branch anchor and
  // never leaks the parent's later messages the fork never saw — a true fork.
  // Empty string when nothing's been said yet.
  const transcriptBlock = (chat: ChatNode, clipAt?: string): string => {
    let msgs = chat.data.messages
    if (clipAt) {
      const i = msgs.findIndex((m) => m.id === clipAt)
      if (i >= 0) msgs = msgs.slice(0, i + 1) // anchor not found → keep full, lose nothing
    }
    return msgs
      .filter((m) => m.text)
      .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.text}`)
      .join('\n\n')
  }

  // Connections are UNDIRECTED: an attachment edge means "these two are
  // connected" — which end is source/target is just how the wire happened to
  // be drawn. What a connection does comes from the node kinds (a note shares
  // its text, a tab its page, a chat its transcript), toggles (the pointer
  // icon arms driving a connected tab), and asking (a connected note is
  // edited only on request). Legacy 'output' edges count as plain connections.
  const isAttachment = (e: PersistedEdge): boolean => e.kind === 'context' || e.kind === 'output'
  const peersOf = (id: string): CanvasNode[] =>
    get().edges.flatMap((e) => {
      if (!isAttachment(e)) return []
      const peerId = e.source === id ? e.target : e.target === id ? e.source : null
      if (!peerId) return []
      const n = get().nodes.find((x) => x.id === peerId)
      return n ? [n] : []
    })

  // Notes connected to a chat go along with every send — read from the store,
  // which always holds the freshest content (autosave debounce notwithstanding).
  const contextNotesFor = (id: string): { id: string; title: string; content: string }[] =>
    peersOf(id)
      .filter(isNote)
      .map((n) => ({ id: n.id, title: n.data.title || 'Untitled note', content: n.data.content }))

  // The chats whose transcripts `id` already carries because its session forks
  // from them: the direct fork-parent chain (fork of a fork resumes the whole
  // chain). Their *transcripts* must not be re-injected as context blocks — but
  // their *documents* still must, since a connected note lives in the system
  // prompt, rebuilt per-send from each chat's own edges, never in the session.
  const forkLineageOf = (id: string): Set<string> => {
    const edges = get().edges
    const out = new Set<string>()
    let cur = id
    // Only fork edges carry a sourceMessageId (context/output/derive never do).
    for (;;) {
      const e = edges.find((x) => x.target === cur && x.sourceMessageId)
      if (!e || out.has(e.source)) break
      out.add(e.source)
      cur = e.source
    }
    return out
  }

  // The chats whose transcripts/documents ride `id`'s sends, oldest → newest —
  // the shared basis for transcript blocks (contextChatsFor) and the documents
  // those chats carry (gathered in dispatchTurn). Two sources, deliberately
  // different depths:
  //  • Fork ancestry, walked to the ROOT: the session resumes those
  //    transcripts, but their attached documents ride the system prompt
  //    (rebuilt per-send from each chat's own connections), so every ancestor
  //    must be gathered. Each arrives with `clipAt` set to its branch anchor
  //    (a true fork: post-branch turns excluded); contextChatsFor drops the
  //    lineage's transcripts since the resumed session already holds them.
  //  • Connected chats, ONE hop only — direct connections of the sender or of
  //    a fork ancestor. A connected chat brings its transcript and its own
  //    directly-attached resources, never its further neighborhood: with
  //    undirected connections, wiring two working chats together must not
  //    silently haul in each other's entire canvas ("direct context only").
  const upstreamChats = (id: string): { chat: ChatNode; clipAt?: string }[] => {
    const nodes = get().nodes
    const edges = get().edges
    const chatById = (nid: string): ChatNode | null => {
      const n = nodes.find((x) => x.id === nid)
      return n && isChat(n) ? n : null
    }
    // Connected chats, either end of the wire — connections are undirected.
    const connectedChatsOf = (chatId: string): ChatNode[] =>
      edges
        .filter((e) => e.kind === 'context' || e.kind === 'output')
        .flatMap((e) => {
          const peerId = e.source === chatId ? e.target : e.target === chatId ? e.source : null
          const n = peerId ? chatById(peerId) : null
          return n ? [n] : []
        })
    const seen = new Set<string>([id])
    // Own fork ancestry, nearest parent first (cycle-safe by `seen`).
    const ancestry: { chat: ChatNode; clipAt?: string }[] = []
    let curId = id
    for (;;) {
      const forkEdge = edges.find((x) => x.target === curId && x.sourceMessageId)
      const parent = forkEdge ? chatById(forkEdge.source) : null
      if (!parent || seen.has(parent.id)) break
      seen.add(parent.id)
      ancestry.push({ chat: parent, clipAt: forkEdge?.sourceMessageId })
      curId = parent.id
    }
    // Oldest ancestor first, so transcript blocks read in conversation order.
    const out: { chat: ChatNode; clipAt?: string }[] = [...ancestry].reverse()
    // One hop of connections from the sender and each fork ancestor.
    for (const baseId of [id, ...ancestry.map((a) => a.chat.id)]) {
      for (const c of connectedChatsOf(baseId)) {
        if (seen.has(c.id)) continue
        seen.add(c.id)
        out.push({ chat: c })
      }
    }
    return out
  }

  // Upstream chats as serialized transcript blocks — same shape as a context
  // note, so main injects them identically. Fork parents arrive clipped. The
  // target's fork lineage is dropped: its transcript already rides the resumed
  // session, so re-injecting it would only duplicate the conversation.
  const contextChatsFor = (id: string): { id: string; title: string; content: string }[] => {
    const lineage = forkLineageOf(id)
    return upstreamChats(id).flatMap(({ chat, clipAt }) => {
      if (lineage.has(chat.id)) return []
      const content = transcriptBlock(chat, clipAt)
      return content ? [{ id: chat.id, title: chat.data.title || 'Chat', content }] : []
    })
  }

  // Files connected to a chat go along as paths; main injects the bytes of any
  // the session hasn't seen (isNew, stamped by send/retry) into the turn's
  // user message. A file whose attach hasn't landed yet (no path) sits out.
  const contextFilesFor = (id: string): ContextFile[] =>
    peersOf(id)
      .filter(isFile)
      .flatMap((n) =>
        n.data.file
          ? [
              {
                id: n.id,
                title: n.data.title || (n.data.kind === 'pdf' ? 'Untitled PDF' : 'Untitled image'),
                file: n.data.file
              }
            ]
          : []
      )

  // Links connected to a chat: each send reads the tab's rendered page out of
  // its live <webview> guest as markdown — what the user sees is what the
  // model gets, so bot walls and JS-only pages that defeat a plain fetch don't
  // matter. A link whose guest can't be read (tab minimized, page hung) goes
  // along as a bare URL and main falls back to the WebFetch instruction.
  // A link whose URL hasn't been committed yet sits out.
  const contextLinksFor = (id: string): ContextLink[] =>
    peersOf(id)
      .filter(isLink)
      .flatMap((n) =>
        n.data.url
          ? [
              {
                id: n.id,
                title: n.data.title || hostTitle(n.data.url) || 'Untitled link',
                url: n.data.url
              }
            ]
          : []
      )

  // The tab a computer-use turn drives: the first wired tab (direct wires
  // first, then upstream chats') whose <webview> guest is alive right now —
  // a minimized tab has no guest and sits out, same as page extraction.
  // One rule everywhere: resources wire INTO chats; the wire picks which tab,
  // and the pointer toggle is the one consent gate that grants driving.
  const computerTargetFor = (id: string): ComputerTarget | null => {
    const links = [
      ...contextLinksFor(id),
      ...upstreamChats(id).flatMap((c) => contextLinksFor(c.chat.id))
    ]
    for (const l of links) {
      const webContentsId = guestWebContentsId(l.id)
      if (webContentsId !== null)
        return { targetId: l.id, webContentsId, title: l.title, url: l.url }
    }
    return null
  }

  // Desktop viewport for a driven tab. The webview's CSS viewport is the
  // node's layout size, and below ~1024 CSS px sites serve their mobile
  // layout — hamburger menus, hidden search, no hover — which is much harder
  // for the model to drive. 1280 is the canonical desktop width; 900 tall
  // leaves a ~1280×800 page box under the tab chrome (the classic computer-use
  // envelope). Grow-only: a tab the user already made bigger stays put.
  const COMPUTER_TAB = { width: 1280, height: 900 }
  const growTabForComputer = (targetId: string): void => {
    const node = get().nodes.find((n) => n.id === targetId)
    if (!node || !isLink(node)) return
    const w = node.width ?? node.measured?.width ?? NODE_W
    const h = node.height ?? node.measured?.height ?? 0
    if (w >= COMPUTER_TAB.width && h >= COMPUTER_TAB.height) return
    set((s) => ({
      nodes: s.nodes.map((n) =>
        n.id === targetId
          ? ({
              ...n,
              width: Math.max(w, COMPUTER_TAB.width),
              height: Math.max(h, COMPUTER_TAB.height)
            } as CanvasNode)
          : n
      )
    }))
    persist()
  }

  // A computer-armed send with no wired live tab spawns its own: a Google tab
  // just left of the chat, born at the desktop viewport (so no grow pass) and
  // wired as context like a hand-drawn connection. The turn dispatches once
  // the tab's <webview> guest attaches — see awaitComputerTab.
  const COMPUTER_HOME = 'https://www.google.com'
  const spawnComputerTab = (chat: ChatNode): string => {
    const p = boxOf(chat)
    const node = makeLinkNode(
      { x: p.x - GAP - COMPUTER_TAB.width, y: p.y },
      {
        color: nextColor(),
        updatedAt: Date.now(),
        url: COMPUTER_HOME,
        title: hostTitle(COMPUTER_HOME)
      }
    )
    node.width = COMPUTER_TAB.width
    node.height = COMPUTER_TAB.height
    // One set for node + wire, spawned unselected (same reasons as deriveNote).
    set((s) => ({
      nodes: [...s.nodes, node],
      edges: [...s.edges, { id: uid(), source: node.id, target: chat.id, kind: 'context' as const }]
    }))
    persist()
    return node.id
  }

  // The fresh tab's guest attaches a few frames after the node mounts (webview
  // mount, attach, first load). Poll briefly; null past the deadline — the
  // turn then runs tabless and the model says so, same as a retry whose tab
  // died.
  const GUEST_ATTACH_MS = 10_000
  const awaitComputerTab = async (tabId: string): Promise<ComputerTarget | null> => {
    const deadline = Date.now() + GUEST_ATTACH_MS
    while (Date.now() < deadline) {
      const webContentsId = guestWebContentsId(tabId)
      const node = get().nodes.find((n) => n.id === tabId)
      if (webContentsId !== null && node && isLink(node) && node.data.url) {
        return {
          targetId: tabId,
          webContentsId,
          title: node.data.title || hostTitle(node.data.url) || 'Untitled link',
          url: node.data.url
        }
      }
      await new Promise((r) => setTimeout(r, 100))
    }
    return null
  }

  const withPageContent = (links: ContextLink[]): Promise<ContextLink[]> =>
    Promise.all(
      links.map(async (l) => {
        const content = await extractPageMarkdown(l.id, l.url)
        return content ? { ...l, content } : l
      })
    )

  // Gather every resource wired into a chat and fire the turn over IPC. Shared
  // by send and retry — the only per-call differences are the prompt text and
  // whether research mode rides along. `node` is the chat as it was before the
  // streaming-state update (its session/fork/injected ledger are read here).
  const dispatchTurn = (
    node: ChatNode,
    text: string,
    opts?: { research?: boolean; computer?: ComputerTarget | null }
  ): void => {
    const id = node.id
    const dedupeById = <T extends { id: string }>(xs: T[]): T[] => {
      const seen = new Set<string>()
      return xs.filter((x) => {
        if (seen.has(x.id)) return false
        seen.add(x.id)
        return true
      })
    }
    // Context is direct-only, one hop through chats: upstreamChats yields the
    // fork ancestry plus directly-connected chats, and each contributes the
    // documents on its OWN connections — not relied on to have soaked into
    // that chat's transcript (they never do: a note lives in the system
    // prompt, not the messages, and an unsent edit wouldn't be there at all).
    // Nothing is gathered beyond that hop. Deduped by node id, since the same
    // document can hang off several of these chats.
    const upstreamIds = upstreamChats(id).map((c) => c.chat.id)
    const contextNotes = dedupeById([
      ...contextNotesFor(id),
      ...upstreamIds.flatMap(contextNotesFor),
      ...contextChatsFor(id) // upstream chats themselves, as transcript blocks
    ])
    // Only files the session hasn't seen carry bytes this turn; remember them so
    // a successful turn marks them injected (a failed turn re-sends on retry).
    const injected = new Set(node.data.injectedImages ?? [])
    const contextFiles = dedupeById([
      ...contextFilesFor(id),
      ...upstreamIds.flatMap(contextFilesFor)
    ]).map((f) => ({ ...f, isNew: !injected.has(f.id) }))
    const newFileIds = contextFiles.filter((f) => f.isNew).map((f) => f.id)
    if (newFileIds.length > 0) pendingFileInjections.set(id, newFileIds)
    else pendingFileInjections.delete(id)
    // Reading the tabs' rendered pages is async — the composer already cleared
    // and the bubble is streaming-pending, so the await is invisible (and capped
    // by pageText's extraction timeout).
    void (async () => {
      const contextLinks = await withPageContent(
        dedupeById([...contextLinksFor(id), ...upstreamIds.flatMap(contextLinksFor)])
      )
      void window.api.thread.send({
        nodeId: id,
        text,
        sessionId: node.data.sessionId,
        model: get().model,
        effort: get().effort,
        // first send of a forked node: fork the parent session at the anchor
        ...(!node.data.sessionId && node.data.forkOf ? { forkFrom: node.data.forkOf } : {}),
        ...(opts?.research ? { research: true } : {}),
        ...(opts?.computer ? { computer: opts.computer } : {}),
        ...(contextNotes.length > 0 ? { contextNotes } : {}),
        ...(contextFiles.length > 0 ? { contextFiles } : {}),
        ...(contextLinks.length > 0 ? { contextLinks } : {})
      })
    })()
  }

  // A fresh node takes over keyboard focus (focusDraft) and clears everyone
  // else's selection. Whether it grabs the React Flow *selection* depends on the
  // view: on the bare canvas it stays unselected, because a selected newborn
  // sitting next to an already-selected node makes React Flow drag the pair as a
  // unit (the note-moves-the-chat bug — same reason deriveNote spawns unselected).
  // With a sheet open we keep the old behavior: the new node becomes the
  // selection so it's the panel's focus.
  const adopt = <T extends CanvasNode>(node: T): T => {
    const selected = get().expanded !== null
    const placed = { ...node, selected }
    set((s) => ({
      nodes: [...s.nodes.map((n) => (n.selected ? { ...n, selected: false } : n)), placed]
    }))
    persist()
    return placed
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
        updatedAt: Date.now(),
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
    placingContextSource: null,
    pendingFile: null,
    ctxConnectSource: null,
    shiftPicks: [],
    shiftHeld: false,
    transforming: null,
    expanded: null,

    // The pending image lives and dies with file-placement mode. Any re-arm or
    // cancel also drops a pending context source — it only rides a C-armed chat.
    setPlacing: (kind) =>
      set(
        kind === 'file'
          ? { placing: kind, placingContextSource: null }
          : { placing: kind, pendingFile: null, placingContextSource: null }
      ),

    // "Chat about this": arm a chat ghost that carries a dimmed pending context
    // edge from the resource (the note/file/link's right knob, or C while
    // reading a file/link in the half-sheet). Re-arming the same source disarms
    // (toggle), matching the toolbar buttons.
    armContextChat: (sourceId) => {
      const s = get()
      const src = s.nodes.find((n) => n.id === sourceId)
      if (!src || !(isFile(src) || isLink(src) || isNote(src))) return
      if (s.placing === 'chat' && s.placingContextSource === sourceId) {
        set({ placing: null, placingContextSource: null })
        return
      }
      set({ placing: 'chat', pendingFile: null, placingContextSource: sourceId })
    },

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

    shiftConnect: (id) => {
      const picks = get().shiftPicks
      // a second click on the same node toggles it back off (mirrors React
      // Flow deselecting it), so a mis-click is easy to undo
      if (picks.includes(id)) {
        set({ shiftPicks: picks.filter((x) => x !== id) })
        return
      }
      const next = [...picks, id]
      if (next.length < 2) {
        set({ shiftPicks: next }) // first pick — wait for the partner
        return
      }
      // Second pick: clear the tally and connect the pair. Connections are
      // undirected, so click order doesn't matter; addContextEdge re-validates
      // (at least one non-research chat in the pair) and no-ops on a bad or
      // duplicate pair — `connected` reads whether a wire actually landed.
      set({ shiftPicks: [] })
      const [aId, bId] = next
      const before = get().edges.length
      get().addContextEdge(aId, bId)
      const connected = get().edges.length > before
      // A wired pair drops the selection it left behind; a non-pair stays
      // multi-selected (React Flow's own shift-select) so it can drag together.
      if (connected)
        set((s) => ({
          nodes: s.nodes.map((n) =>
            (n.id === aId || n.id === bId) && n.selected ? { ...n, selected: false } : n
          )
        }))
    },

    resetShiftConnect: () => {
      if (get().shiftPicks.length) set({ shiftPicks: [] })
    },

    setShiftHeld: (held) => {
      if (get().shiftHeld !== held) set({ shiftHeld: held })
    },

    setTransforming: (id) =>
      set((s) => ({
        transforming: id,
        // Arming transform: deselect the inner node so it sheds its focus ring
        // and the dashed frame stands on its own.
        nodes:
          id == null
            ? s.nodes
            : s.nodes.map((n) => (n.id === id && n.selected ? { ...n, selected: false } : n))
      })),

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
      set({ expanded: { id, mode } })
    },

    collapseExpanded: () => set({ expanded: null }),

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
        nodes: s.nodes.filter((n) => !doomed.has(n.id)),
        edges: s.edges.filter((e) => !doomed.has(e.source) && !doomed.has(e.target))
      }))
      for (const nodeId of doomed) {
        const node = byId.get(nodeId)
        if (node && isNote(node)) void window.api.note.delete(nodeId)
        else if (node && isLink(node))
          void window.api.link.unclip(nodeId) // drop its clip, if any
        else if (node && isFile(node)) {
          // Delete the backing file too, so the top-level scan can't re-surface
          // the card on the next load. (Auto-placed cards derive their id from
          // the filename, so a card that's gone but a file that isn't comes back.)
          if (node.data.file) void window.api.file.delete(node.data.file)
        } else {
          void window.api.canvas.deleteThread(nodeId)
          // A pinned chat left a transcript clip behind — drop it too.
          if (node && isChat(node) && node.data.pinned) void window.api.chat.unclipMemory(nodeId)
        }
      }
      // Write the layout immediately rather than through the 500ms debounce, so
      // a quick close/reopen after a delete can't drop the save.
      clearTimeout(saveTimer)
      saveTimer = undefined
      if (get().loaded) void window.api.canvas.save(buildDoc())
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

    createFolder: async (name, parent) => {
      if (anyStreaming()) return null
      await flushSave()
      return switchFolder(await window.api.folder.create(name, parent))
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

    // Labels are born in edit mode (focusDraft) so you can type right away.
    addLabelAt: (position) => adopt(makeLabelNode(position, { focusDraft: true })),

    addLinkAt: (position, url) => {
      const node = makeLinkNode(position, {
        color: nextColor(),
        updatedAt: Date.now(),
        ...(url ? { url, title: hostTitle(url) } : {})
      })
      if (url) node.height = LINK_FRAME.height
      return adopt(node)
    },

    openLinkInPanel: (url, sourceId) => {
      // Drop the tab just right of the node the link was clicked in (so its
      // canvas card has a sensible home), or at the viewport's top-left when
      // there's no source.
      const src = sourceId ? get().nodes.find((n) => n.id === sourceId) : undefined
      const vp = get().viewport
      const position = src
        ? { x: src.position.x + (src.width ?? NODE_W) + GAP, y: src.position.y }
        : { x: (-vp.x + 80) / vp.zoom, y: (-vp.y + 80) / vp.zoom }
      const node = get().addLinkAt(position, url)
      // One tab at a time in the panel — the fresh tab replaces whatever was open.
      set({ expanded: { id: node.id, mode: 'panel' } })
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
      if (!node) return

      // Links can't be Read in place — they're a live tab, not a file. Joining
      // memory clips the rendered page (Defuddle, the same extractor a chat uses)
      // to a hidden markdown file the agent Reads on demand. The extraction lives
      // here in the renderer because only it can reach the tab's <webview> guest.
      if (isLink(node)) {
        if (node.data.pinned) {
          patchData(id, { pinned: false, description: undefined })
          persist()
          void window.api.link.unclip(id)
          return
        }
        const url = node.data.url
        if (!url) return
        // Clipping is async (extract → write → describe), so flip `pinned` NOW:
        // the button reflects it instantly and a second click reads "pinned" and
        // unpins, instead of kicking off a duplicate clip. Hold off on persist()
        // until the clip file exists, so MEMORY.md never lists a missing clip; if
        // the user unpins mid-flight, `pinned` is already false and each step
        // below bails (and cleans up a clip it may have written).
        patchData(id, { pinned: true })
        const stillPinned = (): boolean => {
          const cur = get().nodes.find((n) => n.id === id)
          return !!cur && isLink(cur) && !!cur.data.pinned
        }
        void (async () => {
          const markdown = await extractPageMarkdown(id, url)
          if (!stillPinned()) return // unpinned while extracting — nothing written yet
          if (!markdown) {
            patchData(id, { pinned: false }) // roll back the optimistic flip
            persist()
            // No live guest (tab minimized/hung) or the page wouldn't extract.
            useToastStore.getState().show('Open this page in its tab, then add it to memory')
            return
          }
          const ok = await window.api.link.clip(id, { title: node.data.title, url, markdown })
          if (!stillPinned()) {
            void window.api.link.unclip(id) // unpinned during clip — undo the file
            return
          }
          if (!ok) {
            patchData(id, { pinned: false })
            persist()
            useToastStore.getState().show('Couldn’t save this page to memory')
            return
          }
          persist() // clip exists now → MEMORY.md can list it
          // Describe from the clip we just took (text summarizer, like a note).
          const description = await window.api.note.describe(markdown)
          if (!description || !stillPinned()) return
          patchData(id, { description })
          persist()
        })()
        return
      }

      // Chats have no file of their own — like a link, joining memory snapshots
      // the transcript to a hidden clip the agent Reads on demand. Optimistic
      // flip + stillPinned guard mirror the link flow; the transcript is already
      // in hand (renderer-held messages), so there's no async extraction step.
      if (isChat(node)) {
        if (node.data.kind === 'research') return // display-only researcher transcript
        if (node.data.pinned) {
          patchData(id, { pinned: false, description: undefined })
          persist()
          void window.api.chat.unclipMemory(id)
          return
        }
        const transcript = chatTranscript(node.data.messages)
        if (!transcript.trim()) {
          useToastStore.getState().show('This chat is empty — nothing to remember yet')
          return
        }
        patchData(id, { pinned: true })
        const stillPinned = (): boolean => {
          const cur = get().nodes.find((n) => n.id === id)
          return !!cur && isChat(cur) && !!cur.data.pinned
        }
        void (async () => {
          const ok = await window.api.chat.clipMemory(id, { title: node.data.title, transcript })
          if (!stillPinned()) {
            void window.api.chat.unclipMemory(id) // unpinned during write — undo the file
            return
          }
          if (!ok) {
            patchData(id, { pinned: false })
            persist()
            useToastStore.getState().show('Couldn’t save this chat to memory')
            return
          }
          persist() // clip exists now → MEMORY.md can list it
          const description = await window.api.note.describe(transcript)
          if (!description || !stillPinned()) return
          patchData(id, { description })
          persist()
        })()
        return
      }

      // Notes and files (images/PDFs) are already on disk — just flip the flag.
      if (!isNote(node) && !isFile(node)) return
      const pinned = !node.data.pinned
      patchData(id, { pinned })
      persist() // pin state + the regenerated MEMORY.md ride the canvas save
      // First pin of a resource that has content but no blurb: describe it now
      // so the index line isn't bare. Notes describe their text; files their
      // pixels/pages.
      if (pinned && !node.data.description) {
        if (isNote(node) ? node.data.content.trim() : node.data.file) {
          get().scheduleDescribe(id)
        }
      }
    },

    refreshChatMemory: (id) => {
      const node = get().nodes.find((n) => n.id === id)
      if (!node || !isChat(node) || !node.data.pinned) return
      const transcript = chatTranscript(node.data.messages)
      if (!transcript.trim()) return
      // Keep the clip the agent Reads current with every turn — that's the full
      // content. The 1-3 sentence blurb only describes the opening of the chat
      // (describe sees the first slice), so generate it once and keep it; no need
      // to re-run Haiku on every reply.
      void window.api.chat.clipMemory(id, { title: node.data.title, transcript })
      if (!node.data.description) get().scheduleDescribe(id)
    },

    scheduleDescribe: (id) => {
      const existing = describeTimers.get(id)
      if (existing) clearTimeout(existing)
      describeTimers.set(
        id,
        setTimeout(() => {
          describeTimers.delete(id)
          const node = get().nodes.find((n) => n.id === id)
          if (!node || !node.data.pinned) return
          // The describe call differs by kind (text vs. vision), but the
          // commit is the same: cache the blurb if the node is still pinned.
          const commit = (description: string | null): void => {
            if (!description) return
            const cur = get().nodes.find((n) => n.id === id)
            // The node may have been unpinned or deleted while Haiku ran.
            if (cur && (isNote(cur) || isFile(cur) || isChat(cur)) && cur.data.pinned) {
              patchData(id, { description })
              persist()
            }
          }
          if (isNote(node)) {
            const content = node.data.content.trim()
            if (!content) return
            void window.api.note.describe(content).then(commit)
          } else if (isFile(node) && node.data.file) {
            void window.api.file.describe(node.data.file).then(commit)
          } else if (isChat(node)) {
            // Chats summarize like notes — a text turn over the transcript. The
            // describe handler caps it at 1-3 sentences, so even a long chat
            // gets a terse index line.
            const transcript = chatTranscript(node.data.messages)
            if (!transcript.trim()) return
            void window.api.note.describe(transcript).then(commit)
          }
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

    toggleComputer: (id) => {
      const node = get().nodes.find((n) => n.id === id)
      if (node && isChat(node)) patchData(id, { computerArmed: !node.data.computerArmed })
    },

    toggleResearch: (id) => {
      const node = get().nodes.find((n) => n.id === id)
      if (node && isChat(node)) patchData(id, { researchArmed: !node.data.researchArmed })
    },

    respondPermission: (id, requestId, allow) => {
      const node = get().nodes.find((n) => n.id === id)
      if (!node || isFile(node) || isLink(node) || isLabel(node)) return
      if (node.data.pendingPermission?.requestId !== requestId) return
      // Dismiss immediately; main echoes a permission-resolved event regardless.
      patchData(id, { pendingPermission: undefined })
      window.api.thread.respondPermission({ requestId, allow })
    },

    forkChat: (nodeId, at) => {
      const parent = get().nodes.find((n) => n.id === nodeId)
      if (!parent || !isChat(parent)) return null
      // Fork-ahead only: the anchor is always the chat's tip — its latest
      // *settled* assistant reply. Mid-stream the in-flight reply has no uuid
      // yet, so forking while the parent streams branches from the prior turn
      // (already persisted, so the fork is safe). Forking again later anchors on
      // the new tip, and several forks of the same tip share an anchor message.
      const anchor = [...parent.data.messages]
        .reverse()
        .find((m) => m.role === 'assistant' && m.uuid)
      const sessionId = parent.data.sessionId
      if (!anchor?.uuid || !sessionId) return null

      // The forked session carries the parent's context up to the anchor —
      // the node's transcript starts clean and shows only what diverges.
      const node = makeNode(at ?? findForkSpot(parent), {
        // Start untitled like a fresh chat; the title is generated from the
        // fork's own first turn rather than inherited from the parent.
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

    forkWithDraft: (sourceId, draft) => {
      const src = get().nodes.find((n) => n.id === sourceId)
      if (!src) return null
      // A chat forks at its tip (transcript carries the quoted passage as
      // context); a note/file/link spawns a fresh chat wired to read it. Both
      // helpers auto-place the new card just right of the source with its
      // composer focused, so the seeded draft is ready to type under. Nothing
      // sends until the user does — the pending fork is consumed by first send.
      const newId = isChat(src)
        ? get().forkChat(sourceId)
        : isNote(src) || isFile(src) || isLink(src)
          ? get().chatAbout(sourceId)
          : null
      if (!newId) return null
      get().setDraft(newId, draft)
      return newId
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
        const transcript = transcriptBlock(source)
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
      // THE connection creator. Connections are undirected — either argument
      // order lands the same wire (source/target only record how it was
      // drawn). Valid pairs must include at least one chat (a note wired to a
      // note would mean nothing): chat—note/file/link/chat. Research chats are
      // display-only and connect to nothing; labels never connect.
      const s = get()
      const a = s.nodes.find((n) => n.id === sourceId)
      const b = s.nodes.find((n) => n.id === chatId)
      if (!a || !b || sourceId === chatId) return
      const connectable = (n: CanvasNode): boolean =>
        isNote(n) || isFile(n) || isLink(n) || (isChat(n) && n.data.kind !== 'research')
      if (!connectable(a) || !connectable(b)) return
      if (!isChat(a) && !isChat(b)) return
      if (
        s.edges.some(
          (e) =>
            (e.kind === 'context' || e.kind === 'output') &&
            ((e.source === sourceId && e.target === chatId) ||
              (e.source === chatId && e.target === sourceId))
        )
      )
        return // already connected (in either drawn direction)
      set((st) => ({
        edges: [...st.edges, { id: uid(), source: sourceId, target: chatId, kind: 'context' }]
      }))
      persist()
    },

    removeContextEdge: (edgeId) => {
      set((s) => ({ edges: s.edges.filter((e) => e.id !== edgeId) }))
      persist()
    },

    chatAbout: (sourceId, center) => {
      // "Chat about this" from the half-sheet: spawn a fresh chat wired as
      // context (resource → chat), so the reading panel stays put on the doc
      // while the new chat opens with its composer focused on the live canvas
      // beside it. Any readable resource — note, file, or link (not a chat).
      // With `center`, drop the chat centered on that flow-space point (the
      // panel's chat button passes the middle of the visible canvas); else
      // fall back to just right of the source's card.
      const src = get().nodes.find((n) => n.id === sourceId)
      if (!src || !(isNote(src) || isFile(src) || isLink(src))) return null
      const pos = center
        ? { x: center.x - NODE_W / 2, y: center.y - EST_NODE_H / 2 }
        : (() => {
            const p = boxOf(src)
            return { x: p.x + p.w + DERIVE_GAP, y: p.y }
          })()
      const chat = spawnNode(pos)
      get().addContextEdge(sourceId, chat.id)
      return chat.id
    },

    discardNode: (id) => {
      if (isClaudeMd(id)) return // permanent — never discarded as a blank note
      const node = get().nodes.find((n) => n.id === id)
      set((s) => ({
        ...(s.expanded?.id === id ? { expanded: null } : {}),
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

      // Computer use needs a wired, live tab — without one, spawn a fresh tab
      // just left of the chat and wire it, so asking a bare chat to browse
      // just works. The turn dispatches once the tab's guest attaches.
      const computer = node.data.computerArmed ? computerTargetFor(id) : null
      const spawnedTab = node.data.computerArmed && !computer ? spawnComputerTab(node) : null
      // Give the driven tab a desktop viewport before the turn's first
      // screenshot — the resize lands in the DOM long before the agent looks.
      if (computer) growTabForComputer(computer.targetId)

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

      if (spawnedTab) {
        void awaitComputerTab(spawnedTab).then((target) =>
          dispatchTurn(node, text, { research: node.data.researchArmed, computer: target })
        )
      } else {
        dispatchTurn(node, text, { research: node.data.researchArmed, computer })
      }
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

      // Retry repeats the last prompt on the same session; research never
      // re-arms here (it was a one-shot on the original send). Computer use is
      // sticky, so a still-armed chat retries with its tab — if the tab died,
      // the retry just runs without it and the model says so.
      const computer = node.data.computerArmed ? computerTargetFor(id) : null
      if (computer) growTabForComputer(computer.targetId)
      dispatchTurn(node, lastUser.text, { computer })
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
              const isPdf = p.file?.toLowerCase().endsWith('.pdf')
              // File frames are explicit and aspect-true — no screen-fit clamp.
              // Auto-placed cards arrive with no height; a PDF with no height
              // renders every page full-inline, so fall back to the standard
              // PDF frame (width and height) when none was saved.
              const fileFrameDims =
                p.height != null && !p.minimized
                  ? { width: p.width, height: p.height }
                  : isPdf
                    ? { width: PDF_FRAME.width, height: PDF_FRAME.height }
                    : { width: p.width }
              return {
                ...makeFileNode(p.position, fileFrameDims, {
                  title: p.title,
                  color: p.color,
                  kind: isPdf ? ('pdf' as const) : ('image' as const),
                  file: p.file,
                  dataUrl: p.dataUrl,
                  ...(p.pinned ? { pinned: true } : {}),
                  ...(p.description ? { description: p.description } : {}),
                  minimized: p.minimized ?? false,
                  updatedAt: p.updatedAt,
                  ...(p.minimized && p.height != null ? { savedHeight: p.height } : {})
                }),
                id: p.id
              }
            }
            if (p.kind === 'link') {
              const node = makeLinkNode(p.position, {
                title: p.title,
                color: p.color,
                url: p.url,
                ...(p.pinned ? { pinned: true } : {}),
                ...(p.description ? { description: p.description } : {}),
                minimized: p.minimized ?? false,
                updatedAt: p.updatedAt,
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
            if (p.kind === 'label') {
              // Label text rides `title`; its box (width/height) is explicit
              // and aspect-free — no screen-fit clamp.
              return {
                ...makeLabelNode(p.position, { title: p.title, updatedAt: p.updatedAt }),
                id: p.id,
                width: p.width,
                height: p.height ?? LABEL_FRAME.height
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
                ...(p.pinned ? { pinned: true } : {}),
                ...(p.description ? { description: p.description } : {}),
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
  // Mark the note as awaiting its title so the header shows the pulsing "…"
  // only while this turn is actually pending — not for every unnamed note.
  const setPending = (pending: boolean): void => {
    if (!isNoteNode) return
    useCanvasStore.setState((s) => ({
      nodes: s.nodes.map((n) =>
        n.id === nodeId ? ({ ...n, data: { ...n.data, titlePending: pending } } as CanvasNode) : n
      )
    }))
  }
  setPending(true)
  let done = false
  const install = (title: string | null): void => {
    if (done) return
    done = true
    setPending(false)
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
      // Never glue text into a status chip (research/computer) — text that
      // resumes after a chip opens a fresh bubble instead.
      if (last.kind) {
        return {
          messages: [...node.data.messages, { id: uid(), role: 'assistant', text: event.text }]
        }
      }
      return {
        messages: [...node.data.messages.slice(0, -1), { ...last, text: last.text + event.text }]
      }
    })
  } else if (event.type === 'computer-action') {
    // Light up the driven tab: badge + animated drive wire until the turn
    // settles ('done' clears it via drivenTabs).
    if (drivenTabs.get(event.nodeId) !== event.targetId) {
      drivenTabs.set(event.nodeId, event.targetId)
      patch(event.targetId, (node) => (isLink(node) ? { driven: true } : {}))
    }
    // One live chip per contiguous run of browser actions: consecutive actions
    // replace the chip's text (with a running step count from main) instead of
    // stacking one transcript line per click. A trailing empty assistant
    // placeholder stays last so the turn's text keeps streaming into it.
    patch(event.nodeId, (node) => {
      if (!isChat(node)) return {}
      const msgs = node.data.messages
      const tail = msgs[msgs.length - 1]
      const keepTail = tail && tail.role === 'assistant' && !tail.kind && tail.text === ''
      const body = keepTail ? msgs.slice(0, -1) : [...msgs]
      const prev = body[body.length - 1]
      const next =
        prev && prev.kind === 'computer-action'
          ? [...body.slice(0, -1), { ...prev, text: event.text }]
          : [
              ...body,
              {
                id: uid(),
                role: 'assistant' as const,
                text: event.text,
                kind: 'computer-action' as const
              }
            ]
      return { messages: keepTail ? [...next, tail] : next }
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
          {
            id: msgId,
            role: 'assistant' as const,
            text: event.description,
            kind: 'research-spawn' as const
          }
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
      !isFile(node) &&
      !isLink(node) &&
      !isLabel(node) &&
      node.data.pendingPermission?.requestId === event.requestId
        ? { pendingPermission: undefined }
        : {}
    )
  } else if (event.type === 'done') {
    // No credentials: the turn never ran. Surface it as a toast (like an
    // unsupported drop) and quietly revert the node — no error strip, no Retry.
    if (event.needsAuth) {
      useToastStore
        .getState()
        .show(event.error ?? 'Set up a Claude token in Settings to start chatting.')
      patch(event.nodeId, (node) => {
        if (!isChat(node)) return { status: 'idle', pendingPermission: undefined }
        const last = node.data.messages[node.data.messages.length - 1]
        return {
          status: 'idle',
          lastError: undefined,
          pendingPermission: undefined,
          // drop the empty assistant placeholder this turn would have filled
          messages:
            last && last.role === 'assistant' && last.text === ''
              ? node.data.messages.slice(0, -1)
              : node.data.messages
        }
      })
      return
    }
    // The turn settled — the driven tab (if any) is free again.
    const drivenTab = drivenTabs.get(event.nodeId)
    if (drivenTab) {
      drivenTabs.delete(event.nodeId)
      patch(drivenTab, (node) => (isLink(node) ? { driven: false } : {}))
    }
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

    // A turn extended a pinned chat — re-snapshot its transcript clip (and blurb)
    // so memory reflects the conversation as it is now, not when it was pinned.
    if (event.ok) {
      const node = useCanvasStore.getState().nodes.find((n) => n.id === event.nodeId)
      if (node && isChat(node) && node.data.pinned) {
        useCanvasStore.getState().refreshChatMemory(event.nodeId)
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
