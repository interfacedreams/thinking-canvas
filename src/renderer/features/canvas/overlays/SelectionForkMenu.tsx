import { useEffect, useState } from 'react'
import { GitFork } from 'lucide-react'
import { useCanvasStore } from '@renderer/store/canvas'
import { paletteFor } from '@renderer/lib/palette'

// Highlight-to-fork. Selecting text inside any node body that opts in
// (`.select-text` on chats/notes, `.pdf-text-layer` on PDFs) floats a little
// fork button just above the selection. Tapping it forks: a chat source forks
// at its tip; a note/PDF source spawns a chat wired to read it. The new card
// lands just right of the source with the highlighted text seeded into its
// focused composer — the user continues typing their ask from it and sends.
//
// Webview pages live in a separate guest document, so their selections never
// reach this host listener — they need a guest→host bridge and are handled
// separately.

// The composer seed: the bare passage, cursor right after it — the user
// continues typing from the highlighted words. No quotes, no canned
// instruction presuming what the ask is.
function buildSeed(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 4000)
}

interface Pending {
  nodeId: string
  text: string
  // Selection bounds in screen px; the button pins to the top edge, centered.
  cx: number
  top: number
  bottom: number
  accent: string
}

// Surfaces whose text opts into highlight-to-fork. A selection must live inside
// one of these (and inside a React Flow node) to surface the menu.
const FORKABLE_SEL = '.select-text, .pdf-text-layer'

export default function SelectionForkMenu(): React.JSX.Element | null {
  const forkWithDraft = useCanvasStore((s) => s.forkWithDraft)
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
      setPending({
        nodeId,
        text,
        cx: rect.left + rect.width / 2,
        top: rect.top,
        bottom: rect.bottom,
        accent: paletteFor(node.data.color).accent
      })
    }
    document.addEventListener('selectionchange', onSelect)
    return () => document.removeEventListener('selectionchange', onSelect)
  }, [])

  // A pan or zoom moves the text out from under a screen-pinned button — drop it
  // rather than let it drift. (selectionchange keeps it live for normal edits.)
  useEffect(() => {
    if (!pending) return
    const hide = (): void => setPending(null)
    window.addEventListener('wheel', hide, { passive: true })
    return () => window.removeEventListener('wheel', hide)
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

  if (!pending || nodeGone) return null

  const fork = (): void => {
    forkWithDraft(pending.nodeId, buildSeed(pending.text))
    setPending(null)
    window.getSelection()?.removeAllRanges()
  }

  // Sit above the selection; flip below when it hugs the top of the viewport.
  const below = pending.top < 56
  const y = below ? pending.bottom + 8 : pending.top - 8

  return (
    <button
      type="button"
      // Preserve the selection through the click — a mousedown elsewhere would
      // otherwise collapse it before onClick reads pending.text.
      onMouseDown={(e) => e.preventDefault()}
      onClick={fork}
      style={{
        left: pending.cx,
        top: y,
        backgroundColor: pending.accent,
        transform: `translateX(-50%) translateY(${below ? '0' : '-100%'})`
      }}
      className="fixed z-[1100] flex items-center gap-1.5 rounded-full border-2 border-white px-3 py-1.5 text-[13px] font-medium text-white shadow-md transition-transform hover:brightness-110"
    >
      <GitFork className="h-4 w-4" />
      Fork
    </button>
  )
}
