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

// The connection knob: ONE grabbable shape floating above every node.
// Connections are undirected — drag any knob onto any other node (or tap,
// then click one) and the pair is wired; what a connection does comes from
// the node kinds (+ toggles and asking), never from which way it was drawn.
// Resources wear a square, chats a circle — the same shape coding the
// sidebar list uses.
//
// React Flow still needs a source and a target handle to complete a drag, so
// every knob is a stacked pair at the same spot: the visible knob is the
// SOURCE (owns all pointer gestures — drag out, tap to arm) and an invisible
// same-size TARGET sits underneath to receive drops (connectionRadius snaps
// by handle position, not pointer-events). Edges always render source-knob →
// target-knob, indistinguishable since both live at the same point.
export const CTX_HANDLE_ID = 'ctx' // the target half
export const OUTPUT_HANDLE_ID = 'ctx-out' // the source half (the visible knob)

// Sizing/placement is inline because React Flow's stylesheet pins handles to
// a 6px dot; hover/snap effects live in main.css under .ctx-handle.
export const ctxHandleStyle = (
  accent: string,
  side: 'top' | 'bottom' | 'right' = 'top',
  shape: 'circle' | 'square' = 'circle'
): React.CSSProperties => ({
  // top/bottom ride the horizontal center; right rides the vertical center
  // top input and right output sit the same 21px outside their edge (equal
  // padding); bottom output rides a touch closer.
  ...(side === 'top' ? { top: -21 } : side === 'bottom' ? { bottom: -15 } : { right: -21 }),
  ...(side === 'right' ? { top: '50%' } : { left: '50%' }),
  // 31px ≈ 24 × 1.3. The translate(-50%, -50%) pins each knob by its center, so
  // growing the box keeps the same anchor point — the offsets above don't change.
  width: 31,
  height: 31,
  borderRadius: shape === 'circle' ? '50%' : 6,
  background: accent,
  border: '2px solid #FFFFFF',
  boxShadow: '0 1px 4px rgba(0, 0, 0, 0.2)'
})

// The invisible drop-target half of the knob pair — same geometry as the
// visible knob so snapping lands exactly where the user aims.
export const ctxTargetStyle = (): React.CSSProperties => ({
  ...ctxHandleStyle('transparent'),
  border: 'none',
  boxShadow: 'none',
  opacity: 0,
  pointerEvents: 'none'
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
