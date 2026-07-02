import { useMemo, useState } from 'react'
import { useReactFlow } from '@xyflow/react'
import {
  Brain,
  FileCode2,
  FileText,
  Globe,
  Image as ImageIcon,
  Info,
  MessageSquare,
  Minus,
  Plus,
  X
} from 'lucide-react'
import { useCanvasStore, isNote, isFile, isLink, isChat, type CanvasNode } from '../store/canvas'
import { paletteFor } from '../lib/palette'
import { usePersistedCollapse } from '../lib/usePersistedCollapse'
import Tooltip from './Tooltip'

// White paper — the corner legends share the black-and-white vocabulary of the
// top-right selectors (model / effort / repo).
const PAPER = '#FFFFFF'

/**
 * "Memory" legend on the canvas's left edge: the durable context every new chat
 * sees. At the top, a CLAUDE.md jump link (the project's always-on
 * instructions); beneath it, the pinned notes that make up the project memory
 * index. Clicking any entry centers the viewport on its node (the same jump the
 * Recent panel does). The app owns the index end to end — the user curates it
 * only by pinning and unpinning notes; the generated MEMORY.md itself is no
 * longer shown here (the pinned list above is the same information, legible),
 * and the Info button in the header opens a popover explaining how the index is
 * built.
 *
 * Always present (CLAUDE.md alone is enough to populate it). Positioning is
 * owned by the top-left overlay container in Canvas, which stacks it under the
 * Actions legend.
 */
export default function MemoryLegend(): React.JSX.Element | null {
  const nodes = useCanvasStore((s) => s.nodes)
  const toggleMinimize = useCanvasStore((s) => s.toggleMinimize)
  const { fitView } = useReactFlow()
  const [collapsed, setCollapsed] = usePersistedCollapse('memory')
  const [explain, setExplain] = useState(false)

  // Every pinned resource — notes, files (images/PDFs), clipped web pages and
  // chat transcripts — makes up the memory index; they share this list in
  // canvas order.
  const pinned = useMemo(
    () => nodes.filter((n) => (isNote(n) || isFile(n) || isLink(n) || isChat(n)) && n.data.pinned),
    [nodes]
  )
  // The always-present CLAUDE.md node — surfaced here as a jump link so the
  // project's instructions are reachable from the same "what the agent sees" panel.
  const claudeMd = useMemo(
    () => nodes.find((n) => isNote(n) && n.data.system === 'claudeMd'),
    [nodes]
  )

  const focusNode = (node: CanvasNode): void => {
    const fit = (): void => {
      void fitView({ nodes: [{ id: node.id }], duration: 300, padding: 0.1, maxZoom: 1 })
    }
    if (node.data.minimized) {
      toggleMinimize(node.id)
      setTimeout(fit, 50)
    } else {
      fit()
    }
  }

  // Nothing to show — no CLAUDE.md node yet and nothing pinned.
  if (!claudeMd && pinned.length === 0) return null

  if (collapsed) {
    return (
      <button
        type="button"
        onClick={() => setCollapsed(false)}
        title="Show project memory"
        className="flex h-9 cursor-pointer items-center gap-1.5 rounded-[6px] border border-black bg-white px-3.5 text-[12px] font-semibold text-black shadow-lg transition-colors hover:bg-neutral-100"
      >
        <Plus className="h-3.5 w-3.5" />
        Memory
      </button>
    )
  }

  return (
    <aside
      className="flex max-h-[clamp(240px,40vh,520px)] w-56 flex-col overflow-hidden rounded-[14px] border border-black shadow-lg"
      style={{ backgroundColor: PAPER }}
    >
      <div className="flex shrink-0 items-center justify-between border-b border-neutral-200 py-1.5 pl-3.5 pr-1.5">
        <h2 className="text-[12px] font-semibold text-black">Memory</h2>
        <div className="flex shrink-0 items-center gap-1">
          <Tooltip label="What is project memory?">
            <button
              type="button"
              onClick={() => setExplain(true)}
              className="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-black transition-colors hover:bg-neutral-200"
            >
              <Info className="h-3.5 w-3.5" />
            </button>
          </Tooltip>
          <button
            type="button"
            onClick={() => setCollapsed(true)}
            title="Hide project memory"
            className="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-md bg-neutral-100 text-black transition-colors hover:bg-neutral-200"
          >
            <Minus className="h-4 w-4" />
          </button>
        </div>
      </div>
      {explain && <MemoryExplainer onClose={() => setExplain(false)} />}
      <div className="flex min-h-0 flex-col p-1">
        {/* CLAUDE.md — the project's instructions, every chat sees them. Click
            to jump to its node on the canvas (same as a pinned note). It stays
            pinned above the scrolling note list. */}
        {claudeMd && (
          <button
            type="button"
            onClick={() => focusNode(claudeMd)}
            title="The project's CLAUDE.md — instructions every chat sees"
            className="flex w-full shrink-0 cursor-pointer items-center gap-2 rounded-[7px] px-2.5 py-1.5 text-left transition-colors hover:bg-neutral-100"
          >
            <FileCode2 className="h-3.5 w-3.5 shrink-0 text-black" />
            <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-black">
              CLAUDE.md
            </span>
          </button>
        )}

        {claudeMd && pinned.length > 0 && (
          <div className="my-1 shrink-0 border-t border-neutral-200" />
        )}

        {/* Pinned notes — capped at ~5 rows tall, then scrolls. Each row is
            ~32px (py-1.5 + 13px line), so 5 rows ≈ 160px. */}
        <div className="min-h-0 max-h-[160px] overflow-y-auto">
          {pinned.map((n) => {
            // Icon by kind so the list reads at a glance: brain for a note,
            // picture for an image, document for a PDF, globe for a web page,
            // speech bubble for a chat.
            const Icon = isChat(n)
              ? MessageSquare
              : isLink(n)
                ? Globe
                : isFile(n)
                  ? n.data.kind === 'pdf'
                    ? FileText
                    : ImageIcon
                  : Brain
            const untitled = isChat(n)
              ? 'Untitled chat'
              : isLink(n)
                ? 'Untitled tab'
                : isFile(n)
                  ? n.data.kind === 'pdf'
                    ? 'Untitled PDF'
                    : 'Untitled image'
                  : 'Untitled note'
            return (
              <button
                key={n.id}
                type="button"
                onClick={() => focusNode(n)}
                title={n.data.title || untitled}
                className={`flex w-full cursor-pointer items-center gap-2 rounded-[7px] px-2.5 py-1.5 text-left transition-colors hover:bg-neutral-100 ${
                  n.selected ? 'bg-neutral-100' : ''
                }`}
              >
                <Icon
                  className="h-3.5 w-3.5 shrink-0"
                  style={{ color: paletteFor(n.data.color).accent }}
                />
                <span className="min-w-0 flex-1 truncate text-[13px] text-neutral-800">
                  {n.data.title || <span className="text-neutral-400 italic">{untitled}</span>}
                </span>
              </button>
            )
          })}
        </div>
      </div>
    </aside>
  )
}

/**
 * Small popover explaining what project memory is and how the MEMORY.md index
 * is built — opened from the ⓘ in the legend header. Read-only; purely
 * explanatory. A centered overlay (not anchored) keeps it readable even when the
 * legend sits in the corner.
 */
function MemoryExplainer({ onClose }: { onClose: () => void }): React.JSX.Element {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/20 p-6"
      onClick={onClose}
    >
      <div
        className="w-[360px] max-w-full rounded-[14px] border border-black shadow-2xl"
        style={{ backgroundColor: PAPER }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-neutral-200 py-2 pl-4 pr-2">
          <h3 className="flex items-center gap-2 text-[14px] font-semibold text-black">
            <Brain className="h-4 w-4" />
            Memory
          </h3>
          <button
            type="button"
            onClick={onClose}
            title="Close"
            className="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-black transition-colors hover:bg-neutral-200"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="p-4">
          <p className="text-[13px] leading-relaxed text-neutral-700">
            Claude can already read any file in this folder on its own — but with many files it
            can&rsquo;t tell which ones matter, or what&rsquo;s inside, without opening each. Memory
            is a curated table of contents that solves both. Add a note, image, PDF, web page or
            chat with the brain icon on its header and it gets a line in{' '}
            <code className="font-mono">MEMORY.md</code>, an index handed to every new chat. Each
            line carries a short description of the contents, so the agent knows your key resources
            exist, what&rsquo;s in them, and opens the right ones on demand (it reads images and
            PDFs too). A web page is clipped to text when you add it, so it stays readable after the
            tab closes.
          </p>
          <pre className="mt-3 overflow-x-auto rounded-[6px] bg-[#F7F2DF] px-3 py-2.5 text-[11px] leading-snug text-neutral-700">
            {`# Project memory

- [Auth ideas](Auth ideas.md) — Token
  refresh flow and open questions.
- [Roadmap](Roadmap.md) — Q3 priorities.`}
          </pre>
          <p className="mt-3 text-[13px] leading-relaxed text-neutral-700">
            The description is generated for you. Remove a resource from memory and its line drops
            back out. <code className="font-mono">CLAUDE.md</code> is different — it&rsquo;s always
            in context in full, no marking needed.
          </p>
        </div>
      </div>
    </div>
  )
}
