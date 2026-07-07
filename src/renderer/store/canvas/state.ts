import type { NodeChange, Viewport } from '@xyflow/react'
import type { ChosenFile, EffortId, FolderState, ModelId, PersistedEdge } from '@shared/types'
import type {
  CanvasNode,
  ChatNode,
  FileNode,
  LabelNode,
  LinkNode,
  NoteNode,
  PanelMode,
  PendingFile
} from './model'

export interface CanvasState {
  nodes: CanvasNode[]
  edges: PersistedEdge[]
  viewport: Viewport
  loaded: boolean
  folder: FolderState | null // null until the first folder:get answers
  model: ModelId // model for new turns; persisted app-wide in localStorage
  setModel: (model: ModelId) => void
  effort: EffortId // thinking effort for new turns; persisted app-wide in localStorage
  setEffort: (effort: EffortId) => void
  // Gravity auto layout: placing, dropping, or growing a card pushes the cards
  // it overlaps out of the way (see store/canvas/autoLayout). App-wide toggle,
  // persisted in localStorage like model/effort.
  autoLayout: boolean
  setAutoLayout: (on: boolean) => void
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
  // A tap on a node's knob. Nothing armed: arm this node. This node armed:
  // disarm (toggle). Another node armed: commit the connection when the pair
  // is valid (knob-to-knob is the natural gesture — the pending arrow snaps
  // right onto the target's knob), otherwise re-arm from this knob.
  tapCtxKnob: (id: string) => void
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
  // Widget nodes (AI-authored HTML cards). A create_widget tool call emits a
  // widget-created event; this materializes the card beside its chat and
  // wires it (widget⟷chat plus the chat's tabs).
  addWidgetFromAgent: (
    chatId: string,
    w: { widgetId: string; title: string; html: string; width?: number; height?: number }
  ) => void
  // update_widget rewrote the HTML on disk — mirror it and remount the frame.
  applyWidgetUpdate: (widgetId: string, patch: { html: string; title?: string }) => void
  // The message bus (MVP: widget↔chat only): a validated canvas.send()
  // message from a widget's sandbox, routed one hop along its context edges —
  // chats accept prompt {text}, which sends a real user turn.
  routeWidgetMessage: (widgetId: string, msg: Record<string, unknown>) => void
  load: () => Promise<Viewport | null>
  persistSoon: () => void
  persistThread: (id: string) => void
}
