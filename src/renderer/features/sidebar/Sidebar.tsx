import { useMemo } from 'react'
import { useReactFlow } from '@xyflow/react'
import { File, Link, Minus, Plus } from 'lucide-react'
import { useCanvasStore, isChat, isNote, isFile, isLink, type CanvasNode } from '@renderer/store/canvas'
import { paletteFor } from '@renderer/lib/palette'
import { usePersistedCollapse } from '@renderer/lib/usePersistedCollapse'

// Most-recently-updated first; nodes that predate updatedAt sink to the bottom.
const byRecency = (a: CanvasNode, b: CanvasNode): number =>
  (b.data.updatedAt ?? 0) - (a.data.updatedAt ?? 0)

// White paper, worn opaque so nodes sliding underneath never show through the
// list — the corner panels share the black-and-white vocabulary of the
// top-right selectors (model / effort / repo).
const PAPER = '#FFFFFF'

/**
 * "Recent" panel floating over the canvas's bottom-left corner: one list of
 * every resource — chats, notes, files (PDFs/images) and links — most recently
 * updated first. Kind is coded by the row marker: a circle for chats and a
 * square for notes (the shapes their canvas connector handles wear), a link
 * icon for links and a file icon for files. Clicking a row does what the node's
 * expand chip does: un-minimize if needed and center the viewport on it.
 * Height hugs the content up to roughly a third of the screen, then scrolls.
 * The header's minus chip (a small cousin of the node windows' minimize chip)
 * collapses the whole panel down to a "+ Recent" pill; clicking it reopens.
 * Positioning is owned by the bottom-left overlay container in Canvas, which
 * seats this panel beside the auth key button.
 */
export default function Sidebar(): React.JSX.Element | null {
  const nodes = useCanvasStore((s) => s.nodes)
  const toggleMinimize = useCanvasStore((s) => s.toggleMinimize)
  const { fitView } = useReactFlow()
  const [collapsed, setCollapsed] = usePersistedCollapse('recent')

  // Every resource shares the list — chats, notes, files and links; only the
  // ephemeral researcher transcripts stay off it.
  const listed = useMemo(
    () =>
      nodes
        .filter(
          (n) => isNote(n) || isFile(n) || isLink(n) || (isChat(n) && n.data.kind !== 'research')
        )
        .sort(byRecency),
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

  if (collapsed) {
    return (
      <button
        type="button"
        onClick={() => setCollapsed(false)}
        title="Show recent list"
        className="flex h-9 cursor-pointer items-center gap-1.5 rounded-[6px] border border-black bg-white px-3.5 text-[12px] font-semibold text-black shadow-lg transition-colors hover:bg-neutral-100"
      >
        <Plus className="h-3.5 w-3.5" />
        Recent
      </button>
    )
  }

  return (
    <aside
      className="flex max-h-[clamp(240px,34vh,480px)] w-56 flex-col overflow-hidden rounded-[14px] border border-black shadow-lg"
      style={{ backgroundColor: PAPER }}
    >
      <div className="flex shrink-0 items-center justify-between border-b border-neutral-200 py-1.5 pl-3.5 pr-1.5">
        <h2 className="text-[12px] font-semibold text-black">Recent</h2>
        <button
          type="button"
          onClick={() => setCollapsed(true)}
          title="Hide recent list"
          className="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-md bg-neutral-100 text-black transition-colors hover:bg-neutral-200"
        >
          <Minus className="h-4 w-4" />
        </button>
      </div>
      <div className="min-h-0 overflow-y-auto p-1">
        {listed.map((n) => {
          const accent = paletteFor(n.data.color).accent
          // Links show their URL directly; everything else shows its title.
          const link = isLink(n)
          const label = link ? n.data.url : n.data.title
          const untitled = isNote(n)
            ? 'Untitled note'
            : isFile(n)
              ? n.data.kind === 'pdf'
                ? 'Untitled PDF'
                : 'Untitled image'
              : link
                ? 'Empty link'
                : 'Untitled chat'
          return (
            <button
              key={n.id}
              type="button"
              onClick={() => focusNode(n)}
              title={label || untitled}
              className={`flex w-full cursor-pointer items-center gap-2 rounded-[7px] px-2.5 py-1.5 text-left transition-colors hover:bg-neutral-100 ${
                n.selected ? 'bg-neutral-100' : ''
              }`}
            >
              {link ? (
                <Link className="h-3 w-3 shrink-0" style={{ color: accent }} />
              ) : isFile(n) ? (
                <File className="h-3 w-3 shrink-0" style={{ color: accent }} />
              ) : (
                <span
                  className={`h-2 w-2 shrink-0 ${isNote(n) ? 'rounded-[2px]' : 'rounded-full'}`}
                  style={{ backgroundColor: accent }}
                />
              )}
              <span className="min-w-0 flex-1 truncate text-[13px] text-neutral-800">
                {label || <span className="text-neutral-400 italic">{untitled}</span>}
              </span>
            </button>
          )
        })}
      </div>
    </aside>
  )
}
