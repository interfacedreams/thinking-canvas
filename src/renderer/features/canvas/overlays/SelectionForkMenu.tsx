import { useEffect, useState } from 'react'
import { GitFork } from 'lucide-react'
import { ViewportPortal, useReactFlow } from '@xyflow/react'
import { useCanvasStore } from '@renderer/store/canvas'
import { paletteFor } from '@renderer/lib/palette'

// Highlight-to-fork. Selecting text inside any node body that opts in
// (`.select-text` on chats/notes, `.pdf-text-layer` on PDFs) floats a little
// fork button just above the selection. Tapping it forks: a chat source forks
// at its tip; a note/PDF source spawns a chat wired to read it. The new card
// lands just right of the source with the highlighted text seeded into its
// focused composer — the user continues typing their ask from it and sends.
//
// The button lives INSIDE the React Flow viewport (ViewportPortal), anchored
// in flow coordinates as an offset from the source node's origin. Pan, zoom,
// card drags, and gravity pushes all move it exactly like the cards — no
// screen-space tracking needed. It scales with zoom like everything else on
// the canvas.
//
// Webview pages live in a separate guest document, so their selections never
// reach this host listener — they need a guest→host bridge and are handled
// separately.

// The composer seed: the bare passage, cursor right after it — the user
// continues typing their ask from the highlighted words. No quotes, no canned
// instruction presuming what the ask is.
function buildSeed(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 4000)
}

interface Pending {
  nodeId: string
  text: string
  // Anchor as a flow-space offset from the source node's origin, so the
  // button rides the node through drags. dy is the top edge when `below` is
  // false, the bottom edge when the selection hugs the viewport top and the
  // button flips underneath.
  dx: number
  dy: number
  below: boolean
  accent: string
}

// Surfaces whose text opts into highlight-to-fork. A selection must live inside
// one of these (and inside a React Flow node) to surface the menu.
const FORKABLE_SEL = '.select-text, .pdf-text-layer'

export default function SelectionForkMenu(): React.JSX.Element | null {
  const forkWithDraft = useCanvasStore((s) => s.forkWithDraft)
  const { screenToFlowPosition } = useReactFlow()
  const [pending, setPending] = useState<Pending | null>(null)

  // Recompute on every selection change. A collapsed/empty selection, or one
  // outside a forkable body, clears the menu.
  useEffect(() => {
    const onSelect = (): void => {
      const sel = window.getSelection()
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) return setPending(null)
      const text = sel.toString().trim()
      if (!text) return setPending(null)

      const range = sel.getRangeAt(0)
      const container = range.commonAncestorContainer
      const host = (
        container.nodeType === Node.ELEMENT_NODE ? container : container.parentElement
      ) as HTMLElement | null
      if (!host?.closest(FORKABLE_SEL)) return setPending(null)

      const nodeEl = host.closest('.react-flow__node') as HTMLElement | null
      const nodeId = nodeEl?.getAttribute('data-id')
      if (!nodeId) return setPending(null)
      const node = useCanvasStore.getState().nodes.find((n) => n.id === nodeId)
      if (!node) return setPending(null)

      const rect = range.getBoundingClientRect()
      if (rect.width === 0 && rect.height === 0) return setPending(null)

      // Sit above the selection; flip below when it hugs the top of the
      // viewport at selection time (a fixed button would land offscreen).
      const below = rect.top < 56
      const cx = rect.left + rect.width / 2
      const anchor = screenToFlowPosition({ x: cx, y: below ? rect.bottom : rect.top })
      setPending({
        nodeId,
        text,
        dx: anchor.x - node.position.x,
        dy: anchor.y - node.position.y,
        below,
        accent: paletteFor(node.data.color).accent
      })
    }
    document.addEventListener('selectionchange', onSelect)
    return () => document.removeEventListener('selectionchange', onSelect)
  }, [screenToFlowPosition])

  // The anchor is an offset from the NODE, but the selection lives in the
  // node's scrollable body — scrolling inside the card moves the text without
  // moving the node. Drop the button rather than let it detach. (Canvas pans
  // are transform-based and never fire scroll events, so they don't hide it.)
  useEffect(() => {
    if (!pending) return
    const hide = (): void => setPending(null)
    document.addEventListener('scroll', hide, { capture: true, passive: true })
    return () => document.removeEventListener('scroll', hide, { capture: true })
  }, [pending])

  // Deleting the source node removes the selected DOM without reliably firing
  // selectionchange, which would leave the button floating over empty canvas —
  // drop it as soon as its node leaves the store.
  const nodeGone = useCanvasStore(
    (s) => pending !== null && !s.nodes.some((n) => n.id === pending.nodeId)
  )
  useEffect(() => {
    if (nodeGone) setPending(null)
  }, [nodeGone])

  // The live node position — updates every frame of a drag or gravity push,
  // carrying the button along with the card.
  const nodePos = useCanvasStore((s) =>
    pending ? s.nodes.find((n) => n.id === pending.nodeId)?.position : undefined
  )

  if (!pending || !nodePos || nodeGone) return null

  const fork = (): void => {
    forkWithDraft(pending.nodeId, buildSeed(pending.text))
    setPending(null)
    window.getSelection()?.removeAllRanges()
  }

  return (
    <ViewportPortal>
      <div
        style={{
          position: 'absolute',
          transform: `translate(${nodePos.x + pending.dx}px, ${nodePos.y + pending.dy}px)`,
          zIndex: 1100,
          pointerEvents: 'all'
        }}
      >
        <button
          type="button"
          // Preserve the selection through the click — a mousedown elsewhere
          // would otherwise collapse it before onClick reads pending.text. The
          // stop keeps React Flow's pane from treating it as a pan/select start.
          onMouseDown={(e) => {
            e.preventDefault()
            e.stopPropagation()
          }}
          onClick={fork}
          style={{
            backgroundColor: pending.accent,
            transform: `translateX(-50%) translateY(${pending.below ? '8px' : 'calc(-100% - 8px)'})`
          }}
          className="nopan nodrag flex items-center gap-1.5 rounded-full border-2 border-white px-3 py-1.5 text-[13px] font-medium whitespace-nowrap text-white shadow-md hover:brightness-110"
        >
          <GitFork className="h-4 w-4" />
          Fork
        </button>
      </div>
    </ViewportPortal>
  )
}
