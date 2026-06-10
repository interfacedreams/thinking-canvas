// Shared between main and renderer. Persistence shapes for .canvas/canvas.json.

export interface RepoInfo {
  path: string
  name: string
  chatCount: number
}

export interface RepoState {
  current: string | null
  recents: RepoInfo[] // repos with at least one chat (plus the current one), most recent first
}

export interface PersistedMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
}

export interface PersistedNode {
  id: string
  position: { x: number; y: number }
  width: number
  height?: number // only set when the user resized; otherwise height tracks content
  title: string
  messages?: PersistedMessage[]
  minimized?: boolean
  sessionId?: string
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
