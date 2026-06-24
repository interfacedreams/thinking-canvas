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
  createParent: string // where "New Folder" creates next — sticky to the last create
}

// The tab nodes' shared session partition: its own persistent cookie jar,
// shared with nothing else in the app — pages there are never logged into
// the user's accounts. Referenced by the renderer's <webview partition=…>
// and by main's window-open handling (popups navigate the tab itself).
export const BROWSE_PARTITION = 'persist:browse'

// How the agent SDK subprocess will authenticate. A stored Claude
// subscription OAuth token (from `claude setup-token`) wins over an API key,
// and an API key set in Settings wins over the ANTHROPIC_API_KEY from .env.
export interface AuthStatus {
  method: 'subscription' | 'apiKey' | 'none'
  tokenSuffix: string | null // last characters of the stored token, for display
  apiKeySuffix: string | null // last characters of the Settings-stored API key, for display
  apiKeySource: 'settings' | 'env' | null // where the active/fallback API key comes from
  hasApiKey: boolean // an API key exists as fallback if the token is removed
  // A stored credential exists in auth.json but could not be decrypted (e.g. the
  // OS keychain identity changed between builds). It is NOT silently ignored:
  // when this is set we refuse to bill the .env key and prompt a re-entry.
  tokenUnreadable: boolean
  apiKeyUnreadable: boolean
}

export interface PersistedMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  uuid?: string // SDK assistant-message uuid — the fork anchor (resumeSessionAt)
  kind?: 'research-spawn' | 'research-done'
}

/** One snapshot of a note's content. The live content is the note's .md file;
 *  these are the prior states preserved each time the boundary is crossed —
 *  'user' captured before an AI turn (so unversioned edits aren't lost) and
 *  'ai' captured after it. */
export interface NoteVersion {
  content: string
  author: 'user' | 'ai'
  at: string // ISO timestamp
}

/** A note's version history — .canvas/notes/<nodeId>.versions.json, beside the
 *  live title-named .md file. Never written into canvas.json. */
export interface NoteDoc {
  version: 1
  versions: NoteVersion[]
}

/** A fork that hasn't materialized yet — applied on the node's first send. */
export interface ForkRef {
  sessionId: string
  messageUuid: string
}

// 'research' nodes are display-only researcher transcripts spawned by a
// research-mode turn — no composer, no forking, no session of their own.
// 'file' nodes pin an image or PDF from the folder onto the canvas.
// 'link' nodes are tabs: an embedded browsable web page (a <webview> browser
// card). 'label' nodes are free-floating text on the canvas — their text rides
// the `title` field (a label has no name distinct from its text), and the box's
// width/height drive wrapping and an auto-fit font size.
// The kind keeps its original name so existing canvas.json files load.
export type NodeKind = 'chat' | 'note' | 'research' | 'file' | 'link' | 'label'

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
  // Link nodes: the embedded page's URL.
  url?: string
  // File nodes (images only): the image bytes as a data URL. Hydrated from
  // the file on load; never written into canvas.json. PDFs render a card
  // from their path alone, so they never carry one.
  dataUrl?: string
  // Hydrated from .canvas/threads/<nodeId>.json on load; never written
  // into canvas.json (saved separately so layout saves stay cheap).
  messages?: PersistedMessage[]
  // Hydrated from the note's file on load; never written into canvas.json.
  content?: string
  // Hydrated from the note's .versions.json sidecar on load; never written
  // into canvas.json (history is large and saves alongside the .md instead).
  noteVersions?: NoteVersion[]
  // Notes: pinned into the project memory index (MEMORY.md). Small metadata,
  // so it rides canvas.json directly.
  pinned?: boolean
  // The one persistent CLAUDE.md node: a note whose file is the folder's
  // CLAUDE.md (not a title-named file). Always present, never deleted, renamed,
  // or pinned. The flag rides canvas.json so the node is recognized on reload.
  system?: 'claudeMd'
  // Notes: the 1-3 sentence index description (Haiku-generated, cached). Rides
  // canvas.json so the index survives reloads without re-describing.
  description?: string
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
  // prompt (read-only); 'output' wires a chat → note so the chat can read AND
  // write that note (it edits the note's file directly); 'derive' records that
  // a note was generated from this source node (any node → note). Omitted means
  // 'fork' (canvases that predate the rest).
  kind?: 'fork' | 'context' | 'output' | 'derive'
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

// --- Thinking effort ---

// How much thinking/reasoning the model applies to a turn. The id maps straight
// to the Agent SDK's `effort` option; main validates against this list. The
// emoji is the at-a-glance badge shown next to the model picker; the label is
// the word shown in the dropdown menu. Ordered low → high so the menu reads as
// a ramp. The SDK gracefully falls back when a model doesn't support a level
// (e.g. 'xhigh'/'max' degrade to 'high'), so we offer them all.
export const EFFORT_OPTIONS = [
  { id: 'low', label: 'Low', emoji: '💤' },
  { id: 'medium', label: 'Medium', emoji: '🤔' },
  { id: 'high', label: 'High', emoji: '🧠' },
  { id: 'xhigh', label: 'X-High', emoji: '🔥' },
  { id: 'max', label: 'Max', emoji: '🚀' }
] as const

export type EffortId = (typeof EFFORT_OPTIONS)[number]['id']

// 'high' is the SDK's own default for adaptive-thinking models.
export const DEFAULT_EFFORT: EffortId = 'high'

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

/** A link (web page) wired to a chat by a context edge. When the tab's
 *  <webview> guest is alive at send time, the renderer extracts the rendered
 *  page as markdown (Defuddle — the Obsidian clipper's extractor) and it rides
 *  the system prompt like a note's content, refreshed every turn: the page the
 *  model reads is the page the user sees, bot walls and JS-rendering
 *  notwithstanding. Without content (tab minimized, page hung) the system
 *  prompt falls back to carrying the URL with a WebFetch instruction. */
export interface ContextLink {
  id: string
  title: string
  url: string
  /** The rendered page as markdown, when the tab could be read at send time. */
  content?: string
}

export interface ThreadSendArgs {
  nodeId: string
  text: string
  sessionId?: string
  /** Model for this turn; main falls back to DEFAULT_MODEL when absent or unknown. */
  model?: string
  /** Thinking effort for this turn; main falls back to DEFAULT_EFFORT when absent or unknown. */
  effort?: string
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
  /** Links (web pages) connected to this chat by context edges. */
  contextLinks?: ContextLink[]
  /** Notes this chat may write, wired by output edges (chat → note). Their
   *  content rides the system prompt like contextNotes, but the chat is also
   *  told it may edit the files; main mirrors and versions any change back. */
  outputNotes?: ContextNote[]
}

// --- Global permission settings ---

/** App-wide permission preferences — userData/permissions.json. They apply to
 *  every folder and chat, and take effect immediately (prompts already on
 *  screen that the new settings cover resolve themselves). */
export interface PermissionSettings {
  /** Auto-approve WebSearch and WebFetch instead of prompting each time. */
  allowWebSearch: boolean
  /** Auto-approve every tool — no permission prompts at all. */
  autoAllowAll: boolean
}

export const DEFAULT_PERMISSION_SETTINGS: PermissionSettings = {
  allowWebSearch: false,
  autoAllowAll: false
}

// --- MCP connectors ---

/** App-wide MCP server configuration — userData/mcp.json. Applies to every
 *  folder and chat (the file lives in userData, not per-project). The user
 *  pastes the standard Claude Desktop `mcpServers` JSON shape; enabled servers
 *  are passed to every agent turn and their tools (`mcp__<server>__…`) are
 *  auto-approved, since adding a server is itself consent to use it.
 *
 *  `json` carries the raw config verbatim INCLUDING any credentials, so the
 *  textarea can round-trip for editing. It's encrypted at rest in mcp.json;
 *  the renderer is the local, already-trusted agent host, so the plaintext
 *  crossing IPC matches the app's existing single-user posture. */
export interface McpConfig {
  /** Master switch — off means no servers are passed to the agent. */
  enabled: boolean
  /** Raw JSON text of the mcpServers map. '' when nothing is configured. */
  json: string
  /** Server names parsed from `json` (the map keys), for display + status. */
  serverNames: string[]
  /** Parse/validation error from the stored `json`, or null when it's clean. */
  error: string | null
}

export const DEFAULT_MCP_CONFIG: McpConfig = {
  enabled: false,
  json: '',
  serverNames: [],
  error: null
}

/** One server's live connection status from a probe (query.mcpServerStatus). */
export interface McpServerStatusView {
  name: string
  /** SDK status, plus 'error' for a server missing from the probe result. */
  status: 'connected' | 'failed' | 'needs-auth' | 'pending' | 'disabled' | 'error'
  /** Failure detail when status is 'failed'. */
  error?: string
  /** Tools the server exposed (present when connected). */
  toolCount?: number
}

/** Result of a connection probe: per-server statuses, or a top-level reason it
 *  couldn't run at all (no auth, disabled, unparseable config). */
export interface McpProbeResult {
  ok: boolean
  servers: McpServerStatusView[]
  error?: string
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
  // An agent's edit landed on disk — mirror the fresh content live. nodeId is
  // the note's own id (for an output write it's a different node than the chat
  // that's streaming). versions rides the final settle so history stays live.
  | { nodeId: string; type: 'note-content'; content: string; versions?: NoteVersion[] }
  // A chat turn edited a note's file on disk (memory gardening). nodeId is the
  // affected NOTE node; the renderer reloads it, guarding unsaved user edits.
  | { nodeId: string; type: 'note-external-edit'; content: string; versions?: NoteVersion[] }
  | {
      nodeId: string
      type: 'done'
      ok: boolean
      error?: string
      /** The turn never ran because no Claude credentials are set up — the
       *  renderer surfaces this as a "set up a token" toast, not a node error. */
      needsAuth?: boolean
      messageUuid?: string // uuid of the turn's final assistant message (fork anchor)
      usage?: TurnUsage
      /** Note turns: the note's settled content after the turn, plus its
       *  version history (the 'ai' snapshot is taken as the turn settles). */
      note?: { content: string; versions?: NoteVersion[] }
    }
