import { Minus, Plus } from 'lucide-react'
import { useCanvasStore } from '../store/canvas'
import { useSpawn } from '../lib/useSpawn'
import { usePersistedCollapse } from '../lib/usePersistedCollapse'

const ACTIONS = [
  { kind: 'chat', label: 'New Chat', keycap: 'C' },
  { kind: 'note', label: 'New Note', keycap: 'N' },
  { kind: 'file', label: 'Add File', keycap: 'F' },
  { kind: 'link', label: 'New Tab', keycap: 'T' },
  { kind: 'label', label: 'New Label', keycap: 'L' }
] as const

// White paper — the corner panels share the black-and-white vocabulary of the
// top-right selectors (model / effort / repo).
const PAPER = '#FFFFFF'

const KEYCAP =
  'flex h-5 min-w-5 items-center justify-center rounded-[4px] border border-neutral-300 bg-neutral-100 px-1 text-[11px] font-semibold text-black shadow-[0_1.5px_0_#d4d4d4]'

/**
 * "Actions" legend floating over the canvas's top-left corner — the spawn
 * buttons (chat / note / file / tab) that used to live in the app header,
 * restyled as rows of the same panel chrome as the Recent legend. Each row
 * shows its bare-letter shortcut in a keycap; an armed row inverts to solid
 * black while its ghost is stuck to the cursor (clicking again disarms).
 * The header's minus chip collapses the panel to a "+ Actions" pill.
 * Positioning is owned by the top-left overlay container in Canvas.
 */
export default function ActionsLegend(): React.JSX.Element {
  const placing = useCanvasStore((s) => s.placing)
  const spawn = useSpawn()
  const [collapsed, setCollapsed] = usePersistedCollapse('actions')

  if (collapsed) {
    return (
      <button
        type="button"
        onClick={() => setCollapsed(false)}
        title="Show actions"
        className="flex h-9 cursor-pointer items-center gap-1.5 rounded-[6px] border border-black bg-white px-3.5 text-[12px] font-semibold text-black shadow-lg transition-colors hover:bg-neutral-100"
      >
        <Plus className="h-3.5 w-3.5" />
        Actions
      </button>
    )
  }

  return (
    <aside
      className="flex w-56 flex-col overflow-hidden rounded-[14px] border border-black shadow-lg"
      style={{ backgroundColor: PAPER }}
    >
      <div className="flex shrink-0 items-center justify-between border-b border-neutral-200 py-1.5 pl-3.5 pr-1.5">
        <h2 className="text-[12px] font-semibold text-black">Actions</h2>
        <button
          type="button"
          onClick={() => setCollapsed(true)}
          title="Hide actions"
          className="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-md bg-neutral-100 text-black transition-colors hover:bg-neutral-200"
        >
          <Minus className="h-4 w-4" />
        </button>
      </div>
      <div className="p-1">
        {ACTIONS.map(({ kind, label, keycap }) => {
          const armed = placing === kind
          return (
            <button
              key={kind}
              type="button"
              onClick={() => spawn(kind)}
              title={armed ? 'Click the canvas to place — Esc cancels' : `${label} (${keycap})`}
              className={`flex w-full cursor-pointer items-center justify-between rounded-[7px] px-2.5 py-1.5 text-left text-[13px] font-medium transition-colors ${
                armed
                  ? 'bg-black text-white hover:bg-neutral-800'
                  : 'text-neutral-800 hover:bg-neutral-100'
              }`}
            >
              <span>{label}</span>
              <span className={KEYCAP}>{keycap}</span>
            </button>
          )
        })}
      </div>
    </aside>
  )
}
