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
export type NodeKind = 'chat' | 'note' | 'research'

/** One snapshot in a note's history. A version boundary is the end of an AI
 *  turn — or the start of one, capturing the user's unversioned edits first. */
export interface NoteVersion {
  content: string
  author: 'user' | 'ai'
  at: string // ISO timestamp
}

/** A note's version history — .canvas/notes/<nodeId>.versions.json.
 *  The live content is the title-named .md file at the folder root. */
export interface NoteDoc {
  version: 1
  versions: NoteVersion[]
}

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
  file?: string
  // Hydrated from .canvas/threads/<nodeId>.json on load; never written
  // into canvas.json (saved separately so layout saves stay cheap).
  messages?: PersistedMessage[]
  // Hydrated from the note's file + .canvas/notes/<nodeId>.versions.json on
  // load; never written into canvas.json.
  content?: string
  noteVersions?: NoteVersion[]
  minimized?: boolean
  sessionId?: string
  forkOf?: ForkRef
}

export interface PersistedEdge {
  id: string
  source: string
  target: string
  sourceMessageId: string
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

// --- Thread IPC (renderer ⇄ main) ---

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
      /** Note turns: final content + history after the turn's version snapshot. */
      note?: { content: string; versions: NoteVersion[] }
    }
