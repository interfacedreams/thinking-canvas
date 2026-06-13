import { useEffect, useRef, useState } from 'react'
import { getBezierPath, Position, useReactFlow, ViewportPortal } from '@xyflow/react'
import {
  useCanvasStore,
  isChat,
  isFile,
  isLink,
  isNote,
  NODE_W,
  type CanvasNode
} from '../store/canvas'
import { paletteFor } from '../lib/palette'

// Click-to-connect: once a source's bottom circle is tapped (ctxConnectSource
// in the store), this overlay draws a faded arrow from that circle to the
// cursor. Landing on a valid target snaps the arrow onto its top port — where
// it stays, pulsing, until the cursor strays — and a click commits. Any other
// click, or Escape, cancels. Two flavours share this geometry (source bottom →
// target top): a resource (note/file/link) → chat context edge, and a chat →
// note output edge. The source's kind picks which targets are valid.

// Sources: a resource feeds a chat; a chat feeds a note.
const isCtxSource = (n: CanvasNode): boolean =>
  isNote(n) || isFile(n) || isLink(n) || (isChat(n) && n.data.kind !== 'research')

// Given the armed source, is `n` a valid drop target? A chat source feeds
// notes; any other source feeds chats.
const isCtxTarget = (source: CanvasNode, n: CanvasNode): boolean =>
  isChat(source) ? isNote(n) : isChat(n) && n.data.kind !== 'research'

// Circle geometry mirrors ctxHandleStyle: center 15px outside the node edge
// (above for chats, below for notes), radius 12 — the pending arrow runs from
// the note circle's bottom to the chat circle's top like a committed edge.
const CIRCLE_OFFSET = 15
const CIRCLE_R = 12
// Snap radius is SCREEN px (divided by zoom before hit-testing) so the
// reach feels the same at every zoom level. The snap zone is a tight halo
// around the chat's circle — aim at the circle, not the node. One radius
// for both snapping on and letting go.
const SNAP_RADIUS = 20

const nodeCx = (n: CanvasNode): number =>
  n.position.x + (n.width ?? n.measured?.width ?? NODE_W) / 2

// chats: circle above the top edge — the pending arrow lands on its top
const chatCircleCenter = (n: CanvasNode): { x: number; y: number } => ({
  x: nodeCx(n),
  y: n.position.y - CIRCLE_OFFSET
})
// …with a little gap so the arrowhead rests above the circle's white ring
// instead of digging into it (matches ContextEdge's TARGET_GAP).
const chatCircleTop = (n: CanvasNode): { x: number; y: number } => ({
  x: nodeCx(n),
  y: n.position.y - CIRCLE_OFFSET - CIRCLE_R - 3
})

// notes: circle below the bottom edge — the arrow leaves from its bottom
const noteCircleBottom = (n: CanvasNode): { x: number; y: number } => ({
  x: nodeCx(n),
  y: n.position.y + (n.height ?? n.measured?.height ?? 0) + CIRCLE_OFFSET + CIRCLE_R
})

function hits(n: CanvasNode, p: { x: number; y: number }, radius: number): boolean {
  const c = chatCircleCenter(n)
  return Math.hypot(p.x - c.x, p.y - c.y) <= radius
}

function PendingArrow({ sourceId }: { sourceId: string }): React.JSX.Element | null {
  const { screenToFlowPosition, getZoom } = useReactFlow()
  const addContextEdge = useCanvasStore((s) => s.addContextEdge)
  const addOutputEdge = useCanvasStore((s) => s.addOutputEdge)
  const setCtxConnectSource = useCanvasStore((s) => s.setCtxConnectSource)
  const sourceNode = useCanvasStore((s) => s.nodes.find((n) => n.id === sourceId))
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null)
  const [snapId, setSnapId] = useState<string | null>(null)
  const snapRef = useRef<string | null>(null)
  const targetNode = useCanvasStore((s) =>
    snapId ? s.nodes.find((n) => n.id === snapId) : undefined
  )

  // Stale-source guard: the source got deleted (or the folder switched) — stand down.
  useEffect(() => {
    if (!sourceNode || !isCtxSource(sourceNode)) setCtxConnectSource(null)
  }, [sourceNode, setCtxConnectSource])

  // Follow the cursor and resolve the snap target: the topmost chat whose
  // circle the cursor is within SNAP_RADIUS of (later nodes render on top).
  useEffect(() => {
    const onMove = (e: PointerEvent): void => {
      const p = screenToFlowPosition({ x: e.clientX, y: e.clientY })
      setCursor(p)
      const radius = SNAP_RADIUS / getZoom()
      const nodes = useCanvasStore.getState().nodes
      const source = nodes.find((n) => n.id === sourceId)
      let next: string | null = null
      if (source) {
        for (let i = nodes.length - 1; i >= 0; i--) {
          const n = nodes[i]
          if (isCtxTarget(source, n) && hits(n, p, radius)) {
            next = n.id
            break
          }
        }
      }
      if (next !== snapRef.current) {
        snapRef.current = next
        setSnapId(next)
      }
    }
    window.addEventListener('pointermove', onMove)
    return () => window.removeEventListener('pointermove', onMove)
  }, [screenToFlowPosition, getZoom, sourceId])

  // Snapped click commits; any other click cancels. The arming tap never
  // lands here: these listeners attach a tick after it finished propagating
  // (and the circles stopPropagation besides).
  useEffect(() => {
    const onClick = (): void => {
      if (snapRef.current) {
        // Read the source fresh so a chat source commits an output edge and a
        // resource source commits a context edge.
        const src = useCanvasStore.getState().nodes.find((n) => n.id === sourceId)
        if (src && isChat(src)) addOutputEdge(sourceId, snapRef.current)
        else addContextEdge(sourceId, snapRef.current)
      }
      setCtxConnectSource(null)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setCtxConnectSource(null)
    }
    window.addEventListener('click', onClick)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('click', onClick)
      window.removeEventListener('keydown', onKey)
    }
  }, [addContextEdge, addOutputEdge, setCtxConnectSource, sourceId])

  if (!sourceNode || !isCtxSource(sourceNode)) return null
  const snapped = snapId && targetNode ? targetNode : null
  const t = snapped ? chatCircleTop(snapped) : cursor
  if (!t) return null // no cursor fix yet — nothing to draw

  const accent = paletteFor(sourceNode.data.color).accent
  const s = noteCircleBottom(sourceNode)
  const [path] = getBezierPath({
    sourceX: s.x,
    sourceY: s.y,
    sourcePosition: Position.Bottom,
    targetX: t.x,
    targetY: t.y,
    targetPosition: Position.Top
  })

  return (
    <ViewportPortal>
      <svg
        width="1"
        height="1"
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          overflow: 'visible',
          pointerEvents: 'none'
        }}
        className={snapped ? 'ctx-pending ctx-snapped' : 'ctx-pending'}
      >
        <defs>
          <marker
            id="ctx-pending-arrow"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="6"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill={accent} />
          </marker>
        </defs>
        <path
          d={path}
          fill="none"
          stroke={accent}
          strokeWidth={3}
          markerEnd="url(#ctx-pending-arrow)"
          className="ctx-pending-line"
        />
        {snapped && (
          <circle
            cx={chatCircleCenter(snapped).x}
            cy={chatCircleCenter(snapped).y}
            r={CIRCLE_R + 4}
            fill="none"
            stroke={accent}
            strokeWidth={2.5}
            className="ctx-pending-ring"
          />
        )}
      </svg>
    </ViewportPortal>
  )
}

export default function ContextConnectOverlay(): React.JSX.Element | null {
  const sourceId = useCanvasStore((s) => s.ctxConnectSource)
  if (!sourceId) return null
  // Keyed so arming a different source restarts with fresh cursor/snap state.
  return <PendingArrow key={sourceId} sourceId={sourceId} />
}
