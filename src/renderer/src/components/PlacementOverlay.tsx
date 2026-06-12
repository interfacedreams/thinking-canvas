import { useEffect, useRef, useState } from 'react'
import { useReactFlow, useViewport } from '@xyflow/react'
import { FileText } from 'lucide-react'
import { useCanvasStore, fileFrame, FILE_HEADER_H, NODE_W, type PendingFile } from '../store/canvas'
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
  const pendingFile = useCanvasStore((s) => s.pendingFile)

  if (!placing) return null
  if (placing === 'file' && !pendingFile) return null

  // Keyed by mode: switching what's being placed remounts the overlay, so the
  // cursor state starts null and the ghost stays hidden until the first
  // mousemove. Cancelling unmounts it, which resets the same way.
  return <ArmedOverlay key={placing} placing={placing} pendingFile={pendingFile} />
}

function ArmedOverlay({
  placing,
  pendingFile
}: {
  placing: 'chat' | 'note' | 'file'
  pendingFile: PendingFile | null
}): React.JSX.Element {
  const setPlacing = useCanvasStore((s) => s.setPlacing)
  const addNodeAt = useCanvasStore((s) => s.addNodeAt)
  const addNoteAt = useCanvasStore((s) => s.addNoteAt)
  const addFileAt = useCanvasStore((s) => s.addFileAt)
  // The ghost previews the color the node will actually get (palette cycle).
  const color = useCanvasStore((s) => nextColorId(s.nodes[s.nodes.length - 1]?.data.color))
  const { screenToFlowPosition, setCenter } = useReactFlow()
  // Live subscription (not getViewport): forwarded pans/zooms must re-render
  // the ghost so it tracks the canvas without waiting for a mousemove.
  const { zoom } = useViewport()
  const ref = useRef<HTMLDivElement>(null)
  // Cursor position relative to the overlay (null until it first moves here).
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setPlacing(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setPlacing])

  // Files carry their own frame (an image's natural size, capped; PDFs the
  // fixed card); chats and notes share the standard node width.
  const ghostW = placing === 'file' && pendingFile ? fileFrame(pendingFile).width : NODE_W

  const place = (e: React.MouseEvent): void => {
    const p = screenToFlowPosition({ x: e.clientX, y: e.clientY })
    const position = { x: p.x - ghostW / 2, y: p.y - ANCHOR_Y }
    const node =
      placing === 'file'
        ? addFileAt(position)
        : placing === 'note'
          ? addNoteAt(position)
          : addNodeAt(position)
    setPlacing(null)
    if (!node) return
    // Placed while zoomed way out: come in to a readable zoom on the new node.
    if (zoom < 1)
      void setCenter(node.position.x + ghostW / 2, node.position.y + 150, {
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

  const pal = paletteFor(color)
  const isNote = placing === 'note'
  const isFile = placing === 'file'

  return (
    <div
      ref={ref}
      className="absolute inset-0 z-10 cursor-crosshair overflow-hidden"
      onMouseMove={(e) => {
        const rect = e.currentTarget.getBoundingClientRect()
        setCursor({ x: e.clientX - rect.left, y: e.clientY - rect.top })
      }}
      onWheel={forwardWheel}
      onClick={place}
      onContextMenu={(e) => {
        e.preventDefault()
        setPlacing(null)
      }}
    >
      {cursor && (
        <>
          <div
            className="pointer-events-none absolute flex flex-col rounded-[14px] border border-dashed opacity-80"
            style={{
              left: cursor.x - (ghostW / 2) * zoom,
              top: cursor.y - ANCHOR_Y * zoom,
              width: ghostW,
              transform: `scale(${zoom})`,
              transformOrigin: 'top left',
              borderColor: pal.accent,
              // notes and files are paper under a colored header band;
              // chats are solid post-its
              backgroundColor: isNote || isFile ? '#FFFDF699' : `${pal.bg}99`
            }}
          >
            {/* header band: chips + placeholder title, same boxes as the real node */}
            <div
              className={`flex items-center gap-2 border-b px-3 py-1.5 ${isNote || isFile ? 'rounded-t-[13px]' : ''}`}
              style={{
                borderColor: pal.edge,
                ...(isNote || isFile ? { backgroundColor: `${pal.bg}99` } : {})
              }}
            >
              <ChipGhost pal={pal} />
              <ChipGhost pal={pal} />
              <span
                className="min-w-0 flex-1 truncate text-[26px] font-medium opacity-50"
                style={{ color: pal.deep }}
              >
                {isFile
                  ? pendingFile!.name.replace(/\.[^.]+$/, '')
                  : isNote
                    ? 'Untitled note'
                    : 'New chat'}
              </span>
              <div className="ml-auto flex shrink-0 items-center gap-1">
                <ChipGhost pal={pal} />
                <ChipGhost pal={pal} />
              </div>
            </div>

            {isFile && pendingFile!.dataUrl ? (
              // the image itself, at exactly the size the node will land at
              <img
                src={pendingFile!.dataUrl}
                alt=""
                draggable={false}
                className="w-full rounded-b-[13px] object-contain"
                style={{ height: fileFrame(pendingFile!).height - FILE_HEADER_H }}
              />
            ) : isFile ? (
              // PDF: the viewer's gutter with a blank first page, at the size
              // the node will land at
              <div
                className="w-full rounded-b-[13px] bg-neutral-200/60 p-[10px]"
                style={{ height: fileFrame(pendingFile!).height - FILE_HEADER_H }}
              >
                <div className="flex h-full w-full flex-col items-center justify-center gap-2 bg-white/90 shadow-sm">
                  <FileText className="h-10 w-10 opacity-40" style={{ color: pal.deep }} />
                  <span
                    className="max-w-full truncate px-3 text-[15px] opacity-60"
                    style={{ color: pal.deep }}
                  >
                    {pendingFile!.name}
                  </span>
                </div>
              </div>
            ) : isNote ? (
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
