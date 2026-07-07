import { useEffect, useRef, useState, type ReactNode } from 'react'

// A delayed, custom-styled label that pops up below a header chip after the
// pointer has lingered for `delay` ms — replacing the browser's native `title`
// tooltip so the wording can teach what the button does. It hides the moment
// the user clicks (or moves away), since by then they've committed to the
// action and don't need the hint. Wrap a single chip button:
//   <Tooltip label="Delete this chat"><button …>…</button></Tooltip>
export default function Tooltip({
  label,
  delay = 700,
  side = 'bottom',
  children
}: {
  label: string
  delay?: number
  side?: 'top' | 'bottom'
  children: ReactNode
}): React.JSX.Element {
  const [show, setShow] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)

  const cancel = (): void => {
    clearTimeout(timer.current)
    setShow(false)
  }
  // Drop the timer if we unmount mid-hover so it can't fire on a gone node.
  useEffect(() => () => clearTimeout(timer.current), [])

  return (
    <span
      className="nodrag relative inline-flex shrink-0"
      onPointerEnter={() => {
        timer.current = setTimeout(() => setShow(true), delay)
      }}
      onPointerLeave={cancel}
      onPointerDown={cancel}
    >
      {children}
      {show && (
        <span
          role="tooltip"
          className={`pointer-events-none absolute left-1/2 z-50 -translate-x-1/2 whitespace-nowrap rounded-md bg-neutral-900/90 px-2 py-1 text-[12px] font-medium text-white shadow-lg ${
            side === 'top' ? 'bottom-full mb-1.5' : 'top-full mt-1.5'
          }`}
        >
          {label}
        </span>
      )}
    </span>
  )
}
