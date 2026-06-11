import BeeIcon from './BeeIcon'
import FolderChip from './FolderChip'
import ModelSelector from './ModelSelector'
import { useCanvasStore } from '../store/canvas'
import { useSpawn } from '../lib/useSpawn'

// New chat / new note buttons: a written-out label plus a keycap badge
// showing the bare-letter shortcut. White-on-black outline style, the
// inverse of the solid folder chip, so actions read as a different
// category from the workspace selector.
const SPAWN_BUTTON =
  'flex cursor-pointer items-center gap-2 rounded-[6px] border border-black px-3 py-1.5 text-[13px] font-medium shadow-md transition-colors active:scale-95'
// Armed buttons invert (solid black) while their ghost is stuck to the cursor.
const SPAWN_IDLE = 'bg-white text-black hover:bg-neutral-100'
const SPAWN_ARMED = 'bg-black text-white hover:bg-neutral-800'
const KEYCAP =
  'flex h-5 min-w-5 items-center justify-center rounded-[4px] border border-neutral-300 bg-neutral-100 px-1 text-[11px] font-semibold text-black shadow-[0_1.5px_0_#d4d4d4]'

/**
 * Single-row app bar above the canvas: new-chat / new-note on the left,
 * the Bee Claude wordmark dead center, and the model selector + folder
 * chip on the right (folder outermost — it's the workspace anchor).
 * The bar is solid, so canvas nodes can never slide underneath it.
 */
export default function TopBar(): React.JSX.Element {
  const hasFolder = useCanvasStore((s) => Boolean(s.folder?.current))
  const placing = useCanvasStore((s) => s.placing)
  const spawn = useSpawn()

  return (
    <header className="relative z-20 flex h-12 shrink-0 items-center justify-between border-b border-[#E2DAC0] bg-[#FBFAF4] px-4">
      <div className="flex items-center gap-2">
        {hasFolder && (
          <>
            <button
              type="button"
              onClick={() => spawn('chat')}
              title={placing === 'chat' ? 'Click the canvas to place — Esc cancels' : 'New chat (C)'}
              className={`${SPAWN_BUTTON} ${placing === 'chat' ? SPAWN_ARMED : SPAWN_IDLE}`}
            >
              <span>New Chat</span>
              <span className={KEYCAP}>C</span>
            </button>
            <button
              type="button"
              onClick={() => spawn('note')}
              title={placing === 'note' ? 'Click the canvas to place — Esc cancels' : 'New note (N)'}
              className={`${SPAWN_BUTTON} ${placing === 'note' ? SPAWN_ARMED : SPAWN_IDLE}`}
            >
              <span>New Note</span>
              <span className={KEYCAP}>N</span>
            </button>
          </>
        )}
      </div>

      <div className="pointer-events-none absolute top-1/2 left-1/2 flex -translate-x-1/2 -translate-y-1/2 items-center gap-2">
        <BeeIcon className="h-8 w-8" />
        <span className="text-[18px] font-semibold tracking-tight">Bee Claude</span>
      </div>

      <div className="flex items-center gap-2">
        {hasFolder && <ModelSelector />}
        <FolderChip />
      </div>
    </header>
  )
}
