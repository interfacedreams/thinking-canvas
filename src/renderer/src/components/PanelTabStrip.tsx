import { useMemo } from 'react'
import { Globe, X } from 'lucide-react'
import { useCanvasStore, isLink, type LinkNode } from '../store/canvas'

// A tab's label: its given title, else the bare hostname of its URL.
function tabLabel(title: string, url?: string): string {
  if (title) return title
  if (!url) return 'New tab'
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

/**
 * The browsing strip across the top of the side panel: one pill per link tab
 * opened in this session (clicking links in a chat/note stacks them here).
 * Clicking a pill brings that tab to the front; its × drops it from the strip
 * (the tab stays as a card on the canvas). Hidden unless a browsing session is
 * open — a chat/note/file opened on its own shows no strip.
 */
export default function PanelTabStrip(): React.JSX.Element | null {
  // Select the stable slices, then derive the tab list with useMemo — a
  // selector that built the array inline would return a fresh reference every
  // render, which zustand reads as a change and re-renders forever (Maximum
  // update depth exceeded).
  const panelTabs = useCanvasStore((s) => s.panelTabs)
  const nodes = useCanvasStore((s) => s.nodes)
  const tabs = useMemo(
    () =>
      panelTabs
        .map((id) => nodes.find((n) => n.id === id))
        .filter((n): n is LinkNode => !!n && isLink(n)),
    [panelTabs, nodes]
  )
  const activeId = useCanvasStore((s) => s.expanded?.id ?? null)
  const mode = useCanvasStore((s) => s.expanded?.mode ?? 'panel')
  const expandNode = useCanvasStore((s) => s.expandNode)
  const closePanelTab = useCanvasStore((s) => s.closePanelTab)

  if (tabs.length === 0) return null

  return (
    <div className="flex shrink-0 items-stretch gap-1 overflow-x-auto border-b border-(--np-edge) bg-(--np-bg) px-2 py-1">
      {tabs.map((tab) => {
        const active = tab.id === activeId
        return (
          <div
            key={tab.id}
            onClick={() => !active && expandNode(tab.id, mode)}
            title={tab.data.url ?? tab.data.title}
            className={`group flex min-w-0 max-w-[180px] cursor-pointer items-center gap-1.5 rounded-[8px] px-2 py-1 text-[13px] transition-colors ${
              active
                ? 'bg-white text-neutral-900 shadow-sm'
                : 'text-(--np-deep) opacity-70 hover:bg-(--np-chip) hover:opacity-100'
            }`}
          >
            <Globe className="h-3.5 w-3.5 shrink-0 opacity-60" />
            <span className="min-w-0 flex-1 truncate">
              {tabLabel(tab.data.title, tab.data.url)}
            </span>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                closePanelTab(tab.id)
              }}
              title="Close this tab"
              className="shrink-0 rounded-[4px] p-0.5 opacity-50 transition-opacity hover:bg-black/10 hover:opacity-100"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        )
      })}
    </div>
  )
}
