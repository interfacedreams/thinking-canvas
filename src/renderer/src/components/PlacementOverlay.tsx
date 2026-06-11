import { useEffect, useRef, useState } from 'react'
import { useReactFlow, useViewport } from '@xyflow/react'
import { useCanvasStore, NODE_W } from '../store/canvas'
import { nextColorId, paletteFor, type NodePalette } from '../lib/palette'

// Where the node lands relative to the click: horizontally centered, with the
// cursor a couple of rows into the title area — same as double-click spawning.
const ANCHOR_Y = 24

/** Faint stand-in for a header chip button (same h-9 box as CHIP_BUTTON). */
function ChipGhost({ pal }: { pal: NodePalette }): React.JSX.Element {
  return (
    <div className="h-9 w-9 shrink-0 rounded-lg" style={{ backgroundColor: `${pal.edge}66` }} />
  )
}

/**
 * Click-to-place layer over the canvas, mounted while `placing` is armed:
 * a ghost of the upcoming node sticks to the cursor, a click drops the real
 * node there, and Escape / right-click cancels. Clicks and drags are swallowed
 * (the ghost can't poke nodes), but wheel gestures are forwarded to the pane —
 * two-finger pan / pinch-zoom still work, so you can travel while placing.
 *
 * The ghost is a skeleton of the real node — same header / composer / body
 * boxes and paddings as ChatNodeView / NoteNodeView, rendered at NODE_W and
 * scaled by the viewport zoom — so it lands at exactly the size it previews.
 */
export default function PlacementOverlay(): React.JSX.Element | null {
  const placing = useCanvasStore((s) => s.placing)
  const setPlacing = useCanvasStore((s) => s.setPlacing)
  const addNodeAt = useCanvasStore((s) => s.addNodeAt)
  const addNoteAt = useCanvasStore((s) => s.addNoteAt)
  // The ghost previews the color the node will actually get (palette cycle).
  const color = useCanvasStore((s) => nextColorId(s.nodes[s.nodes.length - 1]?.data.color))
  const { screenToFlowPosition, setCenter } = useReactFlow()
  // Live subscription (not getViewport): forwarded pans/zooms must re-render
  // the ghost so it tracks the canvas without waiting for a mousemove.
  const { zoom } = useViewport()
  const ref = useRef<HTMLDivElement>(null)
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null)

  useEffect(() => {
    if (!placing) return
    setCursor(null) // ghost stays hidden until the cursor moves over the canvas
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setPlacing(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [placing, setPlacing])

  if (!placing) return null

  const place = (e: React.MouseEvent): void => {
    const p = screenToFlowPosition({ x: e.clientX, y: e.clientY })
    const position = { x: p.x - NODE_W / 2, y: p.y - ANCHOR_Y }
    const node = placing === 'note' ? addNoteAt(position) : addNodeAt(position)
    setPlacing(null)
    // Placed while zoomed way out: come in to a readable zoom on the new node.
    if (zoom < 1)
      void setCenter(node.position.x + NODE_W / 2, node.position.y + 150, {
        zoom: 1,
        duration: 250
      })
  }

  // Two-finger pan / pinch must keep working while the overlay is up: clone
  // the wheel onto the React Flow pane underneath (same trick as
  // useForwardedWheel) — the overlay itself has nothing to scroll.
  const forwardWheel = (e: React.WheelEvent): void => {
    const pane = ref.current?.parentElement?.querySelector('.react-flow__pane')
    pane?.dispatchEvent(
      new WheelEvent('wheel', {
        deltaX: e.deltaX,
        deltaY: e.deltaY,
        deltaMode: e.deltaMode,
        clientX: e.clientX,
        clientY: e.clientY,
        ctrlKey: e.ctrlKey,
        metaKey: e.metaKey,
        bubbles: true,
        cancelable: true
      })
    )
  }

  const rect = ref.current?.getBoundingClientRect()
  const pal = paletteFor(color)
  const isNote = placing === 'note'

  return (
    <div
      ref={ref}
      className="absolute inset-0 z-10 cursor-crosshair overflow-hidden"
      onMouseMove={(e) => setCursor({ x: e.clientX, y: e.clientY })}
      onWheel={forwardWheel}
      onClick={place}
      onContextMenu={(e) => {
        e.preventDefault()
        setPlacing(null)
      }}
    >
      {cursor && rect && (
        <>
          <div
            className="pointer-events-none absolute flex flex-col rounded-[14px] border border-dashed opacity-80"
            style={{
              left: cursor.x - rect.left - (NODE_W / 2) * zoom,
              top: cursor.y - rect.top - ANCHOR_Y * zoom,
              width: NODE_W,
              transform: `scale(${zoom})`,
              transformOrigin: 'top left',
              borderColor: pal.accent,
              // notes are paper under a colored header band; chats are solid post-its
              backgroundColor: isNote ? '#FFFDF699' : `${pal.bg}99`
            }}
          >
            {/* header band: chips + placeholder title, same boxes as the real node */}
            <div
              className={`flex items-center gap-2 border-b px-3 py-1.5 ${isNote ? 'rounded-t-[13px]' : ''}`}
              style={{
                borderColor: pal.edge,
                ...(isNote ? { backgroundColor: `${pal.bg}99` } : {})
              }}
            >
              <ChipGhost pal={pal} />
              <ChipGhost pal={pal} />
              <span
                className="min-w-0 flex-1 truncate text-[26px] font-medium opacity-50"
                style={{ color: pal.deep }}
              >
                {isNote ? 'Untitled note' : 'New chat'}
              </span>
              <div className="ml-auto flex shrink-0 items-center gap-1">
                <ChipGhost pal={pal} />
                <ChipGhost pal={pal} />
              </div>
            </div>

            {isNote ? (
              // body mirrors NoteEditor's reserved blank-note height
              <div className="mx-1 my-1 pb-1">
                <div className="min-h-[172px] px-3 py-2" />
              </div>
            ) : (
              // empty transcript spacer + composer mock (one-row textarea +
              // telescope/send footer), matching ChatNodeView's blank height
              <>
                <div className="min-h-[98px]" />
                <div className="mx-1 mt-2 mb-1 rounded-[10px] bg-white/60">
                  <div className="px-3 py-2 text-[16px] text-neutral-400">Ask anything…</div>
                  <div className="flex items-center justify-between px-2 pb-1.5">
                    <div className="h-7 w-7" />
                  </div>
                </div>
              </>
            )}
          </div>
        </>
      )}
    </div>
  )
}
