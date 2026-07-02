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
import { useSpawn } from '../lib/useSpawn'

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

// Click-to-connect: once a source's right circle is tapped (ctxConnectSource
// in the store), this overlay draws a faded arrow from that circle to the
// cursor. Landing on a valid target snaps the arrow onto its top port — where
// it stays, pulsing, until the cursor strays — and a click commits. Any other
// click, or Escape, cancels. Two flavours share this geometry (source right →
// target top): a resource (note/file/link) → chat context edge, and a chat →
// note output edge. The source's kind picks which targets are valid.

// Sources: a resource feeds a chat; a chat feeds a note.
const isCtxSource = (n: CanvasNode): boolean =>
  isNote(n) || isFile(n) || isLink(n) || (isChat(n) && n.data.kind !== 'research')

// A chat source can also fork onto empty canvas — but only once it has a tip
// (a completed assistant reply) to branch from. A mid-stream chat still
// qualifies: it forks from its last settled reply (the in-flight one has no
// uuid yet), so you can branch without waiting for the response to finish.
const chatForkable = (n: CanvasNode): boolean =>
  isChat(n) && n.data.messages.some((m) => m.role === 'assistant' && m.uuid)

// Given the armed source, is `n` a valid drop target? A chat source feeds a
// note (output) or another chat (its transcript as context); any other source
// feeds chats. Research chats never take context, so they're never a target.
const isCtxTarget = (source: CanvasNode, n: CanvasNode): boolean =>
  isChat(source)
    ? isNote(n) || (isChat(n) && n.id !== source.id && n.data.kind !== 'research')
    : isChat(n) && n.data.kind !== 'research'

// Circle geometry mirrors ctxHandleStyle: a target's input sits 15px above the
// top edge; a source's output sits 19px past the right edge. Radius 12 — the
// pending arrow runs from the source circle's right to the target circle's top
// like a committed edge.
const CIRCLE_OFFSET = 21
const SOURCE_OFFSET = 21
const CIRCLE_R = 16
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

// sources: circle past the right edge — the arrow leaves from its right side
const sourceCircleRight = (n: CanvasNode): { x: number; y: number } => ({
  x: n.position.x + (n.width ?? n.measured?.width ?? NODE_W) + SOURCE_OFFSET + CIRCLE_R,
  y: n.position.y + (n.height ?? n.measured?.height ?? 0) / 2
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
    p.x >= n.position.x &&
    p.x <= n.position.x + w &&
    p.y >= n.position.y &&
    p.y <= n.position.y + h
  )
}

function PendingArrow({ sourceId }: { sourceId: string }): React.JSX.Element | null {
  const { screenToFlowPosition, getZoom, setCenter } = useReactFlow()
  const addContextEdge = useCanvasStore((s) => s.addContextEdge)
  const addOutputEdge = useCanvasStore((s) => s.addOutputEdge)
  const addNodeAt = useCanvasStore((s) => s.addNodeAt)
  const addNoteAt = useCanvasStore((s) => s.addNoteAt)
  const forkChat = useCanvasStore((s) => s.forkChat)
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
        // Snapped onto a target. A chat source drives a note (output edge) but
        // feeds another chat as context; a resource source always commits a
        // context edge.
        const tgt = useCanvasStore.getState().nodes.find((n) => n.id === snapRef.current)
        if (src && isChat(src) && tgt && isNote(tgt)) addOutputEdge(sourceId, snapRef.current)
        else addContextEdge(sourceId, snapRef.current)
      } else if (src && onPane) {
        // No target, click on empty canvas. A chat forks at the drop point; a
        // resource drops a fresh chat there, wired to it as context (the click
        // equivalent of pressing C while armed). forkChat no-ops on an un-run
        // chat, which then just disarms.
        const p = screenToFlowPosition({ x: e.clientX, y: e.clientY })
        let placed: CanvasNode | null = null
        if (isChat(src)) {
          const forkId = forkChat(sourceId, { x: p.x, y: p.y })
          placed = forkId
            ? (useCanvasStore.getState().nodes.find((n) => n.id === forkId) ?? null)
            : null
        } else if (isNote(src) || isFile(src) || isLink(src)) {
          const node = addNodeAt({ x: p.x - NODE_W / 2, y: p.y - DROP_ANCHOR_Y })
          addContextEdge(sourceId, node.id)
          placed = node
        }
        // Glide to center on the newborn node — same framing as placing with C
        // (PlacementOverlay): center on the node's own position, not the cursor.
        if (placed)
          void setCenter(placed.position.x + NODE_W / 2, placed.position.y + 150, {
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
      // Drop the new node wired to the source when the pair is a valid edge and
      // needs no picker: a chat forks a chat or drives a note; a resource feeds
      // a chat as context. Anything else (file/link/label, or no cursor yet)
      // can't be wired here — fall back to the normal armed-placement spawn.
      if (src && p) {
        const pos = { x: p.x - NODE_W / 2, y: p.y - DROP_ANCHOR_Y }
        if (isChat(src) && kind === 'chat') {
          // forkChat no-ops without a tip; a plain chat still drops, just unwired
          if (!forkChat(sourceId, pos)) addNodeAt(pos)
          return setCtxConnectSource(null)
        }
        if (isChat(src) && kind === 'note') {
          addOutputEdge(sourceId, addNoteAt(pos).id)
          return setCtxConnectSource(null)
        }
        if (!isChat(src) && kind === 'chat') {
          addContextEdge(sourceId, addNodeAt(pos).id)
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
    addOutputEdge,
    addNodeAt,
    addNoteAt,
    forkChat,
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
  const s = sourceCircleRight(sourceNode)
  // A forkable chat, not yet aimed at a note, can drop a fork on empty canvas —
  // ping rings on its knob advertise that the next canvas click does something.
  const canFork = isChat(sourceNode) && chatForkable(sourceNode)
  // The cursor pill spells out what a click will do at this moment. Resource
  // sources (note/file/link) stay silent — clicking empty space to drop a chat
  // or another chat to connect is left for the user to discover; C still works.
  const hint = snapped
    ? 'Click to connect'
    : isChat(sourceNode)
      ? canFork
        ? 'Click empty space to fork · a note or chat to connect · C / N to drop one'
        : 'Click a note or chat to connect · C / N to drop one'
      : null
  const [path] = getBezierPath({
    sourceX: s.x,
    sourceY: s.y,
    sourcePosition: Position.Right,
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
