// Shared chrome for canvas nodes (chat and note views).

// Every header chip button (minimize/expand/fork/delete) shares this shape:
// rounded square, icon centered, palette chip fill that darkens to accent on hover.
export const CHIP_BUTTON =
  'nodrag flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-lg bg-(--np-chip) text-(--np-deep) transition-colors hover:bg-(--np-accent)'

// The "you are here" variant: a chip marking the current state (e.g. the
// open panel's active size). Filled accent, no hover — it reads as selected
// rather than actionable.
export const CHIP_BUTTON_ACTIVE =
  'flex h-9 w-9 shrink-0 cursor-default items-center justify-center rounded-lg bg-(--np-accent) text-white'

// The header band is the node's only drag surface — React Flow matches its
// `drag-handle` class via the node's dragHandle selector (see store/canvas.ts).
// Interactive children opt out with `nodrag` (CHIP_BUTTON includes it).
export const DRAG_HEADER = 'drag-handle cursor-grab active:cursor-grabbing'

// The context connector: the grabbable shape floating just outside every
// resource (notes, images, tabs — below them) and chat (above it) — so a
// source sitting above a chat reads as a clean downward flow. Resources drag
// from theirs; chats receive. One id serves all since handle ids are scoped
// per node. Resources wear a square, chats a circle — the same shape coding
// the sidebar list uses. Both sit the same distance (15px) outside their node.
export const CTX_HANDLE_ID = 'ctx'

// The output connector wires a chat → note (the chat may write the note). The
// chat emits from a circle below it (OUTPUT_HANDLE_ID); the note receives into
// a square above it (INPUT_HANDLE_ID). Distinct ids from CTX_HANDLE_ID so a
// chat (top input + bottom output) and a note (bottom output + top input) can
// each carry both ports without a within-node id collision.
export const OUTPUT_HANDLE_ID = 'ctx-out'
export const INPUT_HANDLE_ID = 'ctx-in'

// Sizing/placement is inline because React Flow's stylesheet pins handles to
// a 6px dot; hover/snap effects live in main.css under .ctx-handle.
export const ctxHandleStyle = (
  accent: string,
  side: 'top' | 'bottom' = 'top',
  shape: 'circle' | 'square' = 'circle'
): React.CSSProperties => ({
  ...(side === 'top' ? { top: -15 } : { bottom: -15 }),
  left: '50%',
  width: 24,
  height: 24,
  borderRadius: shape === 'circle' ? '50%' : 6,
  background: accent,
  border: '2px solid #FFFFFF',
  boxShadow: '0 1px 4px rgba(0, 0, 0, 0.2)'
})

// React Flow's default handle is a visible 6px dot — these are layout anchors only.
export const HIDDEN_HANDLE: React.CSSProperties = {
  opacity: 0,
  pointerEvents: 'none',
  width: 1,
  height: 1,
  minWidth: 0,
  minHeight: 0,
  border: 'none',
  background: 'transparent'
}
