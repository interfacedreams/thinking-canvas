import { useMemo } from 'react'
import { useReactFlow } from '@xyflow/react'
import { useCanvasStore, isChat, isNote, type CanvasNode } from '../store/canvas'
import { paletteFor } from '../lib/palette'

// Most-recently-updated first; nodes that predate updatedAt sink to the bottom.
const byRecency = (a: CanvasNode, b: CanvasNode): number =>
  (b.data.updatedAt ?? 0) - (a.data.updatedAt ?? 0)

// The nodes' paper color (NoteNodeView keeps its own copy) — worn opaque so
// nodes sliding underneath never show through the list.
const PAPER = '#FFFDF6'

/**
 * "Recent" panel floating over the canvas's bottom-left corner: one list of
 * chats and notes together, most recently updated first. Kind is coded by the
 * row marker's shape — circle for chats, square for notes — the same shapes
 * their canvas connector handles wear. Clicking a row does what the node's
 * expand chip does: un-minimize if needed and center the viewport on it.
 * Height hugs the content up to roughly a third of the screen, then scrolls.
 */
export default function Sidebar(): React.JSX.Element | null {
  const nodes = useCanvasStore((s) => s.nodes)
  const toggleMinimize = useCanvasStore((s) => s.toggleMinimize)
  const { fitView } = useReactFlow()

  // Chats and notes share the list; files and ephemeral researcher
  // transcripts stay off it.
  const listed = useMemo(
    () =>
      nodes.filter((n) => isNote(n) || (isChat(n) && n.data.kind !== 'research')).sort(byRecency),
    [nodes]
  )

  const focusNode = (node: CanvasNode): void => {
    const fit = (): void => {
      void fitView({ nodes: [{ id: node.id }], duration: 300, padding: 0.1, maxZoom: 1 })
    }
    if (node.data.minimized) {
      toggleMinimize(node.id)
      // let React Flow re-measure the expanded node before fitting to it
      setTimeout(fit, 50)
    } else {
      fit()
    }
  }

  // An empty floating box looks broken — show nothing until there's a node.
  if (listed.length === 0) return null

  return (
    <aside
      className="absolute bottom-4 left-4 z-10 flex w-56 max-h-[clamp(240px,34vh,480px)] flex-col overflow-hidden rounded-[14px] border border-[#E2DAC0] shadow-lg"
      style={{ backgroundColor: PAPER }}
    >
      <h2 className="shrink-0 border-b border-[#E2DAC0] px-3.5 py-2 text-[12px] font-semibold text-[#92690B]">
        Recent
      </h2>
      <div className="min-h-0 overflow-y-auto p-1">
        {listed.map((n) => {
          const note = isNote(n)
          const untitled = note ? 'Untitled note' : 'Untitled chat'
          return (
            <button
              key={n.id}
              type="button"
              onClick={() => focusNode(n)}
              title={n.data.title || untitled}
              className={`flex w-full cursor-pointer items-center gap-2 rounded-[7px] px-2.5 py-1.5 text-left transition-colors hover:bg-[#F2EDD8] ${
                n.selected ? 'bg-[#F2EDD8]' : ''
              }`}
            >
              <span
                className={`h-2 w-2 shrink-0 ${note ? 'rounded-[2px]' : 'rounded-full'}`}
                style={{ backgroundColor: paletteFor(n.data.color).accent }}
              />
              <span className="min-w-0 flex-1 truncate text-[13px] text-neutral-800">
                {n.data.title || <span className="text-neutral-400 italic">{untitled}</span>}
              </span>
            </button>
          )
        })}
      </div>
    </aside>
  )
}
