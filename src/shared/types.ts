// Shared between main and renderer. Persistence shapes for .canvas/
// (canvas.json holds layout/metadata; threads/<nodeId>.json holds each
// node's transcript) and the thread IPC contract.

export interface FolderInfo {
  path: string
  name: string
  chatCount: number
}

export interface FolderState {
  current: string | null
  recents: FolderInfo[] // folders with at least one chat (plus the current one), most recent first
}

export interface PersistedMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  uuid?: string // SDK assistant-message uuid — the fork anchor (resumeSessionAt)
}

/** A fork that hasn't materialized yet — applied on the node's first send. */
export interface ForkRef {
  sessionId: string
  messageUuid: string
}

// 'research' nodes are display-only researcher transcripts spawned by a
// research-mode turn — no composer, no forking, no session of their own.
// 'file' nodes pin an image or PDF from the folder onto the canvas.
export type NodeKind = 'chat' | 'note' | 'research' | 'file'

export interface PersistedNode {
  id: string
  kind?: NodeKind // omitted means 'chat' (canvases that predate notes)
  position: { x: number; y: number }
  width: number
  height?: number // only set when the user resized; otherwise height tracks content
  title: string
  color?: string // palette id; omitted means the default (butter)
  // Notes: the note's markdown file — a title-named filename at the folder
  // root (e.g. "Auth ideas.md"). Owned by the main process: injected into
  // canvas.json on save from its id→file map, never set by the renderer.
  // File nodes: the file's path relative to the folder root — set by the
  // renderer after file:attach and round-tripped through canvas.json.
  file?: string
  // File nodes (images only): the image bytes as a data URL. Hydrated from
  // the file on load; never written into canvas.json. PDFs render a card
  // from their path alone, so they never carry one.
  dataUrl?: string
  // Hydrated from .canvas/threads/<nodeId>.json on load; never written
  // into canvas.json (saved separately so layout saves stay cheap).
  messages?: PersistedMessage[]
  // Hydrated from the note's file on load; never written into canvas.json.
  content?: string
  minimized?: boolean
  sessionId?: string
  forkOf?: ForkRef
  // Chats: file node ids (images and PDFs) whose bytes were already injected
  // into this chat's session — later turns (and reloads) must not re-send
  // them. The name predates PDF support; kept for canvas.json compatibility.
  injectedImages?: string[]
  // Epoch ms of the node's last content activity — the sidebar's recency order.
  updatedAt?: number
}

export interface PersistedEdge {
  id: string
  source: string
  target: string
  // 'fork' chains chat sessions; 'context' feeds a note into a chat's system
  // prompt. Omitted means 'fork' (canvases that predate context edges).
  kind?: 'fork' | 'context'
  /** Fork edges only: the message in the source chat the edge anchors on. */
  sourceMessageId?: string
}

export interface CanvasDoc {
  version: 1
  nodes: PersistedNode[]
  edges: PersistedEdge[]
  viewport: { x: number; y: number; zoom: number }
}

/** One node's transcript — .canvas/threads/<nodeId>.json. */
export interface ThreadDoc {
  version: 1
  messages: PersistedMessage[]
}

// --- Models ---

// The Agent SDK model tiers the model selector offers. The id goes straight
// into the SDK's `model` option; main validates against this list.
export const MODEL_OPTIONS = [
  { id: 'claude-fable-5', label: 'Fable 5' },
  { id: 'claude-opus-4-8', label: 'Opus 4.8' },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5' }
] as const

export type ModelId = (typeof MODEL_OPTIONS)[number]['id']

export const DEFAULT_MODEL: ModelId = 'claude-sonnet-4-6'

// Cheap one-shot background jobs (chat titles) always run on the small model,
// regardless of the user's picker choice.
export const TITLE_MODEL: ModelId = 'claude-haiku-4-5'

// --- File IPC (renderer ⇄ main) ---

/** What a file node can hold — decided by extension in the main process. */
export type FileKind = 'image' | 'pdf'

/** A picked file (file:choose) — images are previewed and measured before
 *  placement; PDFs place as a fixed card. The source path is attached
 *  (copied/referenced into the folder) on drop. */
export interface ChosenFile {
  sourcePath: string
  name: string
  kind: FileKind
  /** Images only — preview bytes. PDFs are never read into the renderer. */
  dataUrl?: string
}

// --- Thread IPC (renderer ⇄ main) ---

/** A note wired to a chat by a context edge — its content rides the chat's
 *  system prompt for every turn while the connection exists. */
export interface ContextNote {
  /** The note's node id — main resolves it to the note's filename so the
   *  agent knows the file is already in hand and doesn't re-read it. */
  id: string
  title: string
  content: string
}

/** A file (image or PDF) wired to a chat by a context edge. New files are
 *  injected into the turn's user message as image/document blocks (once per
 *  session); the system prompt just lists what's attached. */
export interface ContextFile {
  id: string
  title: string
  /** The file's path relative to the folder root. */
  file: string
  /** Not yet in this chat's session — this turn carries its bytes. */
  isNew?: boolean
}

export interface ThreadSendArgs {
  nodeId: string
  text: string
  sessionId?: string
  /** Model for this turn; main falls back to DEFAULT_MODEL when absent or unknown. */
  model?: string
  /** Fork the parent session at this message instead of resuming `sessionId`. */
  forkFrom?: ForkRef
  /** 'note' runs an editing turn against the note's markdown file instead of a chat. */
  kind?: NodeKind
  /** The note's title, woven into the editing prompt. */
  noteTitle?: string
  /** Research mode: the lead may spawn researcher subagents for this turn. */
  research?: boolean
  /** Notes connected to this chat by context edges, freshest content first-hand
   *  from the renderer's store. */
  contextNotes?: ContextNote[]
  /** Files (images and PDFs) connected to this chat by context edges. */
  contextFiles?: ContextFile[]
}

/** A tool call waiting on the user's Allow/Deny (SDK canUseTool round-trip). */
export interface PermissionRequest {
  requestId: string
  toolName: string
  /** SDK-rendered prompt sentence (e.g. "Claude wants to search the web for …"). */
  title?: string
  input: Record<string, unknown>
}

export interface PermissionReply {
  requestId: string
  allow: boolean
}

/** Per-turn token/cost accounting from the SDK result message. */
export interface TurnUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  costUsd: number
}

export type ThreadEvent =
  | { nodeId: string; type: 'session'; sessionId: string }
  | { nodeId: string; type: 'delta'; text: string }
  // Research mode: a researcher subagent spawned / streamed text / finished.
  // toolUseId is the Agent tool_use id — the renderer maps it to a child node.
  | { nodeId: string; type: 'spawn'; toolUseId: string; description: string }
  | { nodeId: string; type: 'childDelta'; toolUseId: string; text: string }
  | { nodeId: string; type: 'childDone'; toolUseId: string }
  | { nodeId: string; type: 'permission'; request: PermissionRequest }
  // The request settled (user clicked, or the turn was aborted) — dismiss the prompt.
  | { nodeId: string; type: 'permission-resolved'; requestId: string }
  // Note turns: the agent's edit landed on disk — mirror the fresh content live.
  | { nodeId: string; type: 'note-content'; content: string }
  | {
      nodeId: string
      type: 'done'
      ok: boolean
      error?: string
      messageUuid?: string // uuid of the turn's final assistant message (fork anchor)
      usage?: TurnUsage
      /** Note turns: the note's settled content after the turn. */
      note?: { content: string }
    }
