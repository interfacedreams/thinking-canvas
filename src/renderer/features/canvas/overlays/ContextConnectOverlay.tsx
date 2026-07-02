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
} from '@renderer/store/canvas'
import { paletteFor } from '@renderer/lib/palette'
import { useSpawn } from '@renderer/features/canvas/useSpawn'

// While connecting, these bare keys drop a new node where the arrow is aiming.
const SPAWN_KEYS: Record<string, 'chat' | 'note' | 'file' | 'link' | 'label'> = {
  c: 'chat',
  n: 'note',
  f: 'file',
  t: 'link',
  l: 'label'
}
// New nodes drop with their top-left offset from the cursor so the cursor lands
// near the card's top — mirrors PlacementOverlay's ANCHOR_Y.
const DROP_ANCHOR_Y = 24

// Click-to-connect: once a node's knob is tapped (ctxConnectSource in the
// store), this overlay draws a faded arrow from that knob to the cursor.
// Landing on a valid target snaps the arrow onto its knob — where it stays,
// pulsing, until the cursor strays — and a click commits one undirected
// connection. Clicking empty canvas drops a fresh chat there, already
// connected. Any other click, or Escape, cancels.

// Sources: any connectable card (research chats are display-only).
const isCtxSource = (n: CanvasNode): boolean =>
  isNote(n) || isFile(n) || isLink(n) || (isChat(n) && n.data.kind !== 'research')

// Given the armed source, is `n` a valid drop target? Connections are
// undirected, so the only rule is the store's: the pair must include at least
// one non-research chat. A chat source lands on any card; a resource source
// lands on chats. Research chats are display-only — never a target.
const isCtxTarget = (source: CanvasNode, n: CanvasNode): boolean =>
  isChat(source)
    ? n.id !== source.id &&
      (isNote(n) || isFile(n) || isLink(n) || (isChat(n) && n.data.kind !== 'research'))
    : isChat(n) && n.data.kind !== 'research'

// Knob geometry mirrors ctxHandleStyle: every node's knob floats centered
// above its top edge — the pending arrow runs knob to knob like a committed
// connection.
const CIRCLE_OFFSET = 21
const CIRCLE_R = 16
// Snap radius is SCREEN px (divided by zoom before hit-testing) so the
// reach feels the same at every zoom level. The snap zone is a tight halo
// around the chat's circle — aim at the circle, not the node. One radius
// for both snapping on and letting go.
const SNAP_RADIUS = 20

const nodeCx = (n: CanvasNode): number =>
  n.position.x + (n.width ?? n.measured?.width ?? NODE_W) / 2

// the knob above the top edge — the pending arrow lands on (and leaves from) it
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

function hits(n: CanvasNode, p: { x: number; y: number }, radius: number): boolean {
  const c = chatCircleCenter(n)
  if (Math.hypot(p.x - c.x, p.y - c.y) <= radius) return true
  // Anywhere over the target card itself counts too — aiming at the tiny top
  // circle is fussy, and "drop on the node" is what people expect. The arrow
  // still snaps to the circle visually; this only widens where a click lands.
  const w = n.width ?? n.measured?.width ?? NODE_W
  const h = n.height ?? n.measured?.height ?? 0
  return (
    p.x >= n.position.x && p.x <= n.position.x + w && p.y >= n.position.y && p.y <= n.position.y + h
  )
}

function PendingArrow({ sourceId }: { sourceId: string }): React.JSX.Element | null {
  const { screenToFlowPosition, getZoom, setCenter } = useReactFlow()
  const addContextEdge = useCanvasStore((s) => s.addContextEdge)
  const addNodeAt = useCanvasStore((s) => s.addNodeAt)
  const addNoteAt = useCanvasStore((s) => s.addNoteAt)
  const setCtxConnectSource = useCanvasStore((s) => s.setCtxConnectSource)
  const spawn = useSpawn()
  const sourceNode = useCanvasStore((s) => s.nodes.find((n) => n.id === sourceId))
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null)
  // Latest cursor in flow coords, for the key handler (whose effect closure
  // would otherwise capture a stale `cursor`).
  const cursorRef = useRef<{ x: number; y: number } | null>(null)
  // Screen-space cursor too, for the fixed hint pill (flow coords would shrink
  // with zoom; the hint should stay legible at any scale).
  const [screenCursor, setScreenCursor] = useState<{ x: number; y: number } | null>(null)
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
      cursorRef.current = p
      setScreenCursor({ x: e.clientX, y: e.clientY })
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

  // Snapped release commits; any other release cancels. We listen on pointerup,
  // not click: React Flow drives nodes with d3-drag, which swallows the click
  // that follows a pointer-down on a node (stopImmediatePropagation in the
  // bubble phase) — so a click landing on a target chat never arrives. A
  // capture-phase pointerup runs before d3's bubble-phase suppressor and lands.
  // The arming tap never reaches here: this listener attaches a tick after it
  // finished, and the knob stopPropagation's besides.
  useEffect(() => {
    const onCommit = (e: PointerEvent): void => {
      // A tap on a ctx-handle knob arms/disarms through its own onClick — never
      // let this window listener hijack that tap (it would tear the arm right
      // back down). The knob used to shield itself with stopPropagation, but
      // that only works against a bubbling 'click'; we're a capture pointerup.
      if ((e.target as HTMLElement)?.closest?.('.ctx-handle')) return
      const src = useCanvasStore.getState().nodes.find((n) => n.id === sourceId)
      const onPane = (e.target as HTMLElement)?.classList?.contains('react-flow__pane')
      if (snapRef.current) {
        // Snapped onto a target — commit the connection (undirected; the
        // store validates the pair).
        addContextEdge(sourceId, snapRef.current)
      } else if (src && onPane) {
        // No target, click on empty canvas: drop a fresh chat there, already
        // connected to the source (the click equivalent of pressing C while
        // armed). Same behavior for every source kind — a chat source shares
        // its transcript with the newborn, a resource feeds it as context.
        // Forking is the header's GitFork chip, not a knob gesture: the knob
        // always delivers a knob-to-knob connection.
        const p = screenToFlowPosition({ x: e.clientX, y: e.clientY })
        const node = addNodeAt({ x: p.x - NODE_W / 2, y: p.y - DROP_ANCHOR_Y })
        addContextEdge(sourceId, node.id)
        // Glide to center on the newborn node — same framing as placing with C
        // (PlacementOverlay): center on the node's own position, not the cursor.
        void setCenter(node.position.x + NODE_W / 2, node.position.y + 150, {
          zoom: Math.max(getZoom(), 1),
          duration: 250
        })
      }
      setCtxConnectSource(null)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        setCtxConnectSource(null)
        return
      }
      if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return
      const tgt = e.target as HTMLElement
      if (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA' || tgt.isContentEditable) return
      const kind = SPAWN_KEYS[e.key.toLowerCase()]
      if (!kind) return
      e.preventDefault()
      const src = useCanvasStore.getState().nodes.find((n) => n.id === sourceId)
      const p = cursorRef.current
      // Drop the new node wired to the source when the pair is a valid
      // connection (needs at least one chat in the pair): C drops a connected
      // chat from any source; N drops a connected note from a chat source.
      // Anything else (file/link/label, or no cursor yet) can't be wired
      // here — fall back to the normal armed-placement spawn.
      if (src && p) {
        const pos = { x: p.x - NODE_W / 2, y: p.y - DROP_ANCHOR_Y }
        if (kind === 'chat') {
          addContextEdge(sourceId, addNodeAt(pos).id)
          return setCtxConnectSource(null)
        }
        if (isChat(src) && kind === 'note') {
          addContextEdge(sourceId, addNoteAt(pos).id)
          return setCtxConnectSource(null)
        }
      }
      setCtxConnectSource(null)
      spawn(kind)
    }
    window.addEventListener('pointerup', onCommit, true)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerup', onCommit, true)
      window.removeEventListener('keydown', onKey)
    }
  }, [
    addContextEdge,
    addNodeAt,
    addNoteAt,
    spawn,
    screenToFlowPosition,
    setCenter,
    getZoom,
    setCtxConnectSource,
    sourceId
  ])

  if (!sourceNode || !isCtxSource(sourceNode)) return null
  const snapped = snapId && targetNode ? targetNode : null
  const t = snapped ? chatCircleTop(snapped) : cursor
  if (!t) return null // no cursor fix yet — nothing to draw

  const accent = paletteFor(sourceNode.data.color).accent
  const s = chatCircleCenter(sourceNode) // every knob floats top-center now
  // The cursor pill spells out what a click will do at this moment. Resource
  // sources (note/file/link) stay silent — clicking empty space to drop a chat
  // or another chat to connect is left for the user to discover; C still works.
  const hint = snapped
    ? 'Click to connect'
    : isChat(sourceNode)
      ? 'Click a card to connect · empty space for a connected chat · C / N to drop one'
      : null
  const [path] = getBezierPath({
    sourceX: s.x,
    sourceY: s.y,
    sourcePosition: Position.Top,
    targetX: t.x,
    targetY: t.y,
    targetPosition: Position.Top
  })

  return (
    <>
      {screenCursor && hint && (
        <div
          className="pointer-events-none fixed z-[1000] -translate-y-1/2 translate-x-4 rounded-full bg-neutral-900/90 px-2.5 py-1 text-[12px] font-medium whitespace-nowrap text-white shadow-sm"
          style={{ left: screenCursor.x, top: screenCursor.y }}
        >
          {hint}
        </div>
      )}
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
    </>
  )
}

export default function ContextConnectOverlay(): React.JSX.Element | null {
  const sourceId = useCanvasStore((s) => s.ctxConnectSource)
  if (!sourceId) return null
  // Keyed so arming a different source restarts with fresh cursor/snap state.
  return <PendingArrow key={sourceId} sourceId={sourceId} />
}
