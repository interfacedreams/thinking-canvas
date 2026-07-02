import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { X, type LucideIcon } from 'lucide-react'

export interface ModalTab {
  id: string
  label: string
  icon: LucideIcon
}

/**
 * The shared modal shell for the bottom-left dialogs (Settings, Info): a true
 * centered modal over a dark backdrop, with a top row of icon + label tabs and
 * a scrollable content panel beneath. Callers own tab state and render the
 * active tab's content as children. One visual vocabulary for every config/help
 * sheet.
 *
 * Rendered through a portal to document.body so the backdrop escapes the
 * bottom-left toolbar's stacking context (z-10) and actually dims everything —
 * the corner legends and top-right pickers (z-20) included.
 */
export default function TabbedModal({
  title,
  titleIcon: TitleIcon,
  tabs,
  active,
  onTab,
  onClose,
  children
}: {
  title: string
  titleIcon: LucideIcon
  tabs: ModalTab[]
  active: string
  onTab: (id: string) => void
  onClose: () => void
  children: React.ReactNode
}): React.JSX.Element {
  // Escape closes, like any modal.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onClose}
    >
      <div
        className="flex h-[420px] w-[600px] flex-col overflow-hidden rounded-[14px] border border-black bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header row — sized like a note window's header — then a tabs row */}
        <div className="shrink-0">
          <div className="flex shrink-0 items-center gap-2 border-b border-neutral-200 px-3 py-1.5">
            <h2 className="flex min-w-0 flex-1 items-center gap-2 text-[23px] font-medium text-black">
              <TitleIcon className="h-[25px] w-[25px] shrink-0" />
              {title}
            </h2>
            <button
              type="button"
              onClick={onClose}
              className="flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-lg bg-neutral-100 text-black transition-colors hover:bg-neutral-200"
            >
              <X className="h-[25px] w-[25px]" />
            </button>
          </div>
          <div className="flex items-center gap-1 px-3 py-2">
            {tabs.map((t) => {
              const Icon = t.icon
              const isActive = t.id === active
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => onTab(t.id)}
                  className={`flex cursor-pointer items-center gap-2 rounded-[10px] px-3 py-1.5 text-[13px] font-medium transition-colors ${
                    isActive
                      ? 'bg-black text-white'
                      : 'text-neutral-600 hover:bg-neutral-100'
                  }`}
                >
                  <Icon className="h-4 w-4 shrink-0" />
                  {t.label}
                </button>
              )
            })}
          </div>
        </div>

        {/* Content: the active tab's body */}
        <div className="relative flex-1 overflow-y-auto p-5">{children}</div>
      </div>
    </div>,
    document.body
  )
}
