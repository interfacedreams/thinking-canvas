import { useEffect, useRef, useState } from 'react'
import { useReactFlow, useViewport } from '@xyflow/react'
import { FileText } from 'lucide-react'
import {
  useCanvasStore,
  fileFrame,
  FILE_HEADER_H,
  LABEL_FRAME,
  LINK_INPUT_FRAME,
  NODE_W,
  type PendingFile
} from '@renderer/store/canvas'
import { nextColorId, paletteFor, type NodePalette } from '@renderer/lib/palette'

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
  placing: 'chat' | 'note' | 'file' | 'link' | 'label'
  pendingFile: PendingFile | null
}): React.JSX.Element {
  const setPlacing = useCanvasStore((s) => s.setPlacing)
  const addNodeAt = useCanvasStore((s) => s.addNodeAt)
  const addNoteAt = useCanvasStore((s) => s.addNoteAt)
  const addFileAt = useCanvasStore((s) => s.addFileAt)
  const addLabelAt = useCanvasStore((s) => s.addLabelAt)
  const addLinkAt = useCanvasStore((s) => s.addLinkAt)
  const addContextEdge = useCanvasStore((s) => s.addContextEdge)
  // A C-armed chat trails a pending context edge from this resource — drawn
  // dimmed while placing, committed when the chat lands.
  const ctxSource = useCanvasStore((s) => {
    const id = s.placingContextSource
    return id ? (s.nodes.find((n) => n.id === id) ?? null) : null
  })
  // The ghost previews the color the node will actually get (palette cycle).
  const color = useCanvasStore((s) => nextColorId(s.nodes[s.nodes.length - 1]?.data.color))
  const { screenToFlowPosition, setCenter } = useReactFlow()
  // Live subscription (not getViewport): forwarded pans/zooms must re-render
  // the ghost so it tracks the canvas without waiting for a mousemove.
  const { x: vpX, y: vpY, zoom } = useViewport()
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
  // fixed card); labels their small box; chats and notes the standard width.
  const ghostW =
    placing === 'file' && pendingFile
      ? fileFrame(pendingFile).width
      : placing === 'label'
        ? LABEL_FRAME.width
        : NODE_W

  const place = (e: React.MouseEvent): void => {
    const p = screenToFlowPosition({ x: e.clientX, y: e.clientY })
    const position = { x: p.x - ghostW / 2, y: p.y - ANCHOR_Y }
    const node =
      placing === 'file'
        ? addFileAt(position)
        : placing === 'link'
          ? addLinkAt(position)
          : placing === 'label'
            ? addLabelAt(position)
            : placing === 'note'
              ? addNoteAt(position)
              : addNodeAt(position)
    // Commit the pending context edge before setPlacing clears the source.
    if (node && ctxSource && placing === 'chat') addContextEdge(ctxSource.id, node.id)
    setPlacing(null)
    if (!node) return
    // Center on the newborn node at a readable zoom — come in to 100% when
    // zoomed out, but never zoom out from closer (and never page-expand).
    void setCenter(node.position.x + ghostW / 2, node.position.y + 150, {
      zoom: Math.max(zoom, 1),
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
  const isLink = placing === 'link'
  const isLabel = placing === 'label'
  // notes, files, and links are paper under a colored header band
  const isPaper = isNote || isFile || isLink

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
      {cursor &&
        ctxSource &&
        // The pending context edge: from the resource's right caret knob to the
        // ghost's left side, drawn dimmer and dashed so it reads as not-yet-
        // committed. Coords are overlay-relative (= flow * zoom + viewport),
        // matching the ghost. Behind the ghost in DOM order so it tucks under.
        (() => {
          const sw = ctxSource.width ?? ctxSource.measured?.width ?? NODE_W
          const sh = ctxSource.height ?? ctxSource.measured?.height ?? 360
          // Leave from the right caret knob, not the node's body edge: the knob
          // centers SOURCE_OFFSET past the edge and is ~half ctxHandleStyle wide,
          // so its right rim sits ~35px out (matches ContextConnectOverlay).
          const KNOB_RIGHT = 21 + 16
          const ax = vpX + (ctxSource.position.x + sw + KNOB_RIGHT) * zoom
          const ay = vpY + (ctxSource.position.y + sh / 2) * zoom
          const tx = cursor.x - (ghostW / 2) * zoom
          const ty = cursor.y
          const c = Math.max(40, Math.abs(tx - ax) * 0.4)
          return (
            <svg className="pointer-events-none absolute inset-0 h-full w-full overflow-visible">
              <path
                d={`M ${ax} ${ay} C ${ax + c} ${ay}, ${tx - c} ${ty}, ${tx} ${ty}`}
                fill="none"
                stroke={paletteFor(ctxSource.data.color).accent}
                strokeWidth={2}
                strokeDasharray="6 5"
                opacity={0.4}
              />
            </svg>
          )
        })()}
      {cursor && isLabel && (
        // Labels have no chrome — the ghost is just the blue editable box,
        // sized as it will land, with a placeholder hint.
        <div
          className="pointer-events-none absolute flex items-center justify-center rounded-[8px] border-2 border-dashed text-center opacity-80"
          style={{
            left: cursor.x - (ghostW / 2) * zoom,
            top: cursor.y - ANCHOR_Y * zoom,
            width: ghostW,
            height: LABEL_FRAME.height,
            transform: `scale(${zoom})`,
            transformOrigin: 'top left',
            borderColor: '#3B82F6',
            backgroundColor: '#3B82F60D'
          }}
        >
          <span className="text-[20px] font-medium text-[#3B82F6] opacity-70">Label</span>
        </div>
      )}
      {cursor && !isLabel && (
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
              // paper under a colored header band; chats are solid post-its
              backgroundColor: isPaper ? '#FFFDF699' : `${pal.bg}99`
            }}
          >
            {/* header band: chips + placeholder title, same boxes as the real node */}
            <div
              className={`flex items-center gap-2 border-b px-3 py-1.5 ${isPaper ? 'rounded-t-[13px]' : ''}`}
              style={{
                borderColor: pal.edge,
                ...(isPaper ? { backgroundColor: `${pal.bg}99` } : {})
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
                  : isLink
                    ? 'Untitled tab'
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
            ) : isLink ? (
              // link: the slim paste-a-link card, input mock at the size it lands at
              <div
                className="flex items-center px-3"
                style={{ height: LINK_INPUT_FRAME.height - FILE_HEADER_H }}
              >
                <div
                  className="h-10 w-full rounded-[10px] border bg-white/70"
                  style={{ borderColor: pal.edge }}
                />
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
