import { useEffect, useState } from 'react'
import { Download } from 'lucide-react'

// Bottom-center pill shown while an opted-in update downloads, so the wait
// after clicking "Download" isn't a silent void. Hides itself shortly after
// the download completes (the restart prompt takes over).
export default function UpdateProgress(): React.JSX.Element | null {
  const [percent, setPercent] = useState<number | null>(null)

  useEffect(() => {
    window.api.updates.onProgress(({ percent, done }) => {
      setPercent(percent)
      if (done) setTimeout(() => setPercent(null), 1500)
    })
  }, [])

  if (percent === null) return null

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex justify-center">
      <div className="pointer-events-auto flex items-center gap-2.5 rounded-[10px] border border-black bg-white px-3.5 py-2 text-[12px] font-semibold text-black shadow-lg">
        <Download className="h-3.5 w-3.5 shrink-0" />
        <span>Downloading update… {Math.round(percent)}%</span>
        <span className="relative block h-1 w-24 overflow-hidden rounded-full bg-neutral-200">
          <span
            className="absolute inset-y-0 left-0 rounded-full bg-black transition-[width] duration-150"
            style={{ width: `${percent}%` }}
          />
        </span>
      </div>
    </div>
  )
}
