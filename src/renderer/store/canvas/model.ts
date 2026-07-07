import type { Node } from '@xyflow/react'
import type {
  ChosenFile,
  FileKind,
  ForkRef,
  NoteVersion,
  PermissionRequest,
  PersistedEdge,
  PersistedMessage,
  TurnUsage
} from '@shared/types'

export const NODE_W = 600
export const MAX_NODE_H = 1280
// The always-present CLAUDE.md node: a fixed-id note whose body is the folder's
// CLAUDE.md. Main hard-maps this id to the root CLAUDE.md file. Injected on load
// if absent (see ensureClaudeMd), never deletable/renamable/pinnable.
export const CLAUDE_MD_ID = 'claude-md'
export const CLAUDE_MD_POS = { x: 360, y: 32 } // clear of the top-left canvas legends
export const MIN_GROW_H = 280
export const GAP = 24
// The connection knob floats OUTSIDE the card: centered 21px past the top
// (and right) edge with a 31px body (see nodeChrome.ctxHandleStyle), so it
// pokes ~37px out of the node's bounding box. Anything that packs cards
// edge-to-edge must leave this much extra room or the knob buries itself in
// the neighbor.
export const KNOB_CLEARANCE = 37
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
export const EST_NODE_H = 360

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
export const MIN_FILE_W = 240
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
export function measureImage(dataUrl: string): Promise<{ w: number; h: number } | null> {
  return new Promise((resolveDims) => {
    const img = new Image()
    img.onload = () => resolveDims({ w: img.naturalWidth, h: img.naturalHeight })
    img.onerror = () => resolveDims(null)
    img.src = dataUrl
  })
}

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export const uid = (): string => crypto.randomUUID()

export function makeNode(
  position: { x: number; y: number },
  partial?: Partial<ChatData>
): ChatNode {
  return {
    id: uid(),
    type: 'chat',
    position,
    width: NODE_W,
    dragHandle: '.drag-handle',
    data: { title: '', messages: [], status: 'empty', draft: '', minimized: false, ...partial }
  }
}

export function makeNoteNode(
  position: { x: number; y: number },
  partial?: Partial<NoteData>
): NoteNode {
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

export function makeFileNode(
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
export function hostTitle(url: string): string {
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

export function makeLabelNode(
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

export function makeLinkNode(
  position: { x: number; y: number },
  partial?: Partial<LinkData>
): LinkNode {
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

export function boxOf(n: CanvasNode): Rect {
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
 * wherever they want it. Clear of the parent's fork knob, so auto layout
 * (which counts the knob zone as part of the card) has nothing to resolve.
 */
export function findForkSpot(parent: ChatNode): { x: number; y: number } {
  const p = boxOf(parent)
  return { x: p.x + p.w + KNOB_CLEARANCE + GAP, y: p.y }
}
