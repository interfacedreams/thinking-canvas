import { useEffect, useState } from 'react'
import { ImageOff } from 'lucide-react'
import { useToastStore } from '@renderer/ui/toastStore'

// Swooping error banner: drops in from the top edge, holds, then swoops back
// out. Remounted per toast (keyed on id) so the entrance animation always
// replays. Carries the same rounded/bordered/shadowed feel as the canvas
// windows, in alarm red.
const HOLD_MS = 3500
const EXIT_MS = 260

function ToastCard({ message }: { message: string }): React.JSX.Element {
  const clear = useToastStore((s) => s.clear)
  // Starts off-screen above the top edge, then slides into view next frame.
  const [shown, setShown] = useState(false)

  useEffect(() => {
    const enter = requestAnimationFrame(() => setShown(true))
    const leave = setTimeout(() => setShown(false), HOLD_MS)
    const remove = setTimeout(clear, HOLD_MS + EXIT_MS)
    return () => {
      cancelAnimationFrame(enter)
      clearTimeout(leave)
      clearTimeout(remove)
    }
  }, [clear])

  return (
    <div className="pointer-events-none fixed inset-x-0 top-0 z-50 flex justify-center">
      <div
        role="alert"
        onClick={() => setShown(false)}
        className={`pointer-events-auto mt-3 flex max-w-[90vw] cursor-pointer items-center gap-2 rounded-[12px] border border-black/10 bg-red-600 px-4 py-2.5 text-[14px] font-medium text-white shadow-xl transition-all duration-[260ms] ease-out ${
          shown ? 'translate-y-0 opacity-100' : '-translate-y-[140%] opacity-0'
        }`}
      >
        <ImageOff className="h-4 w-4 shrink-0" />
        <span className="min-w-0 break-words">{message}</span>
      </div>
    </div>
  )
}

/** Renders the current toast, if any. Mount once near the app root. */
export default function Toast(): React.JSX.Element | null {
  const toast = useToastStore((s) => s.toast)
  if (!toast) return null
  return <ToastCard key={toast.id} message={toast.message} />
}
