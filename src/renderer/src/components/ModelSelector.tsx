import { useState } from 'react'
import { ChevronDown, Cpu } from 'lucide-react'
import { MODEL_OPTIONS } from '../../../shared/types'
import { useCanvasStore } from '../store/canvas'

/**
 * Model picker that sits beneath the folder chip (top right). The choice
 * applies to the next turn of every chat and note — switching mid-stream
 * never interrupts a running reply, it just shapes the sends that follow.
 */
export default function ModelSelector(): React.JSX.Element {
  const model = useCanvasStore((s) => s.model)
  const setModel = useCanvasStore((s) => s.setModel)
  const [open, setOpen] = useState(false)

  const current = MODEL_OPTIONS.find((m) => m.id === model) ?? MODEL_OPTIONS[0]

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title={current.id}
        className="flex cursor-pointer items-center gap-2 rounded-[6px] border border-black bg-white px-3 py-1.5 text-[13px] font-medium text-black shadow-md transition-colors hover:bg-neutral-100"
      >
        <Cpu className="h-3.5 w-3.5 shrink-0" />
        <span>{current.label}</span>
        <ChevronDown className="h-3 w-3 shrink-0" />
      </button>

      {open && (
        <>
          <div className="fixed inset-0" onClick={() => setOpen(false)} />
          <div className="absolute top-full right-0 mt-2 w-48 overflow-hidden rounded-[6px] border border-black bg-white shadow-xl">
            {MODEL_OPTIONS.map((m) => {
              const isCurrent = m.id === model
              return (
                <button
                  key={m.id}
                  type="button"
                  disabled={isCurrent}
                  onClick={() => {
                    setModel(m.id)
                    setOpen(false)
                  }}
                  className={`flex w-full items-center gap-2 px-3 py-2 text-left transition-colors ${
                    isCurrent ? '' : 'cursor-pointer hover:bg-neutral-100'
                  }`}
                >
                  <span
                    className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                      isCurrent ? 'bg-black' : 'bg-transparent'
                    }`}
                  />
                  <span className="text-[13px] font-medium text-neutral-800">{m.label}</span>
                </button>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}
