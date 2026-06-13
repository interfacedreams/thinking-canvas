import { useState } from 'react'
import { EFFORT_OPTIONS } from '../../../shared/types'
import { useCanvasStore } from '../store/canvas'

/**
 * Thinking-effort picker that sits beside the model selector (top right). The
 * button is just the current level's emoji — a glanceable badge for how hard
 * the model thinks. Clicking it opens the full menu, where each level shows its
 * emoji alongside the word (Low … Max). Like the model choice, it applies to
 * the next turn of every chat and note and never interrupts a running reply.
 */
export default function EffortSelector(): React.JSX.Element {
  const effort = useCanvasStore((s) => s.effort)
  const setEffort = useCanvasStore((s) => s.setEffort)
  const [open, setOpen] = useState(false)

  const current = EFFORT_OPTIONS.find((e) => e.id === effort) ?? EFFORT_OPTIONS[0]

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title={`Thinking: ${current.label}`}
        className="flex cursor-pointer items-center justify-center rounded-[6px] border border-black bg-white px-2.5 py-1.5 text-[13px] font-medium text-black shadow-md transition-colors hover:bg-neutral-100"
      >
        <span aria-hidden>{current.emoji}</span>
      </button>

      {open && (
        <>
          <div className="fixed inset-0" onClick={() => setOpen(false)} />
          <div className="absolute top-full right-0 mt-2 w-40 overflow-hidden rounded-[6px] border border-black bg-white shadow-xl">
            {EFFORT_OPTIONS.map((e) => {
              const isCurrent = e.id === effort
              return (
                <button
                  key={e.id}
                  type="button"
                  disabled={isCurrent}
                  onClick={() => {
                    setEffort(e.id)
                    setOpen(false)
                  }}
                  className={`flex w-full items-center gap-2 px-3 py-2 text-left transition-colors ${
                    isCurrent ? 'bg-neutral-100' : 'cursor-pointer hover:bg-neutral-100'
                  }`}
                >
                  <span className="text-[15px] leading-none" aria-hidden>
                    {e.emoji}
                  </span>
                  <span className="text-[13px] font-medium text-neutral-800">{e.label}</span>
                </button>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}
