import { useState } from 'react'
import { useReactFlow, type Viewport } from '@xyflow/react'
import { ChevronDown, Folder, FolderPlus } from 'lucide-react'
import { useCanvasStore } from '../store/canvas'
import NewFolderCard from './NewFolderCard'

/**
 * Current-folder chip (lives in the top bar) with a dropdown of recent
 * folders — any folder you've chatted in is one click away. Switching
 * folders swaps the whole canvas, so it's blocked while a reply is
 * streaming.
 *
 * "New Folder" flips the dropdown into an inline naming step: type a name,
 * see (and optionally change) where it lands, and Create — no native dialog.
 */
export default function FolderChip(): React.JSX.Element | null {
  const folder = useCanvasStore((s) => s.folder)
  const chooseFolder = useCanvasStore((s) => s.chooseFolder)
  const selectFolder = useCanvasStore((s) => s.selectFolder)
  const anyStreaming = useCanvasStore((s) => s.nodes.some((n) => n.data.status === 'streaming'))
  const [open, setOpen] = useState(false)
  const [naming, setNaming] = useState(false)
  const { setViewport } = useReactFlow()

  if (!folder) return null // folder state not fetched yet

  const apply = (vp: Viewport | null): void => {
    if (vp) void setViewport(vp)
  }
  const close = (): void => {
    setOpen(false)
    setNaming(false)
  }
  const handleChoose = async (): Promise<void> => {
    close()
    apply(await chooseFolder())
  }
  const handleSelect = async (path: string): Promise<void> => {
    close()
    apply(await selectFolder(path))
  }

  const displayName = folder.current
    ? (folder.current.split('/').pop() ?? folder.current)
    : 'Open folder…'

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => (folder.current ? setOpen((o) => !o) : void handleChoose())}
        title={folder.current ?? 'Choose a folder'}
        className="flex h-9 max-w-[280px] cursor-pointer items-center gap-2 rounded-[6px] border border-black bg-black px-3 text-[13px] font-medium text-white shadow-md transition-colors hover:bg-neutral-800"
      >
        <Folder className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate">{displayName}</span>
        {folder.current && <ChevronDown className="h-3 w-3 shrink-0" />}
      </button>

      {open && (
        <>
          <div className="fixed inset-0" onClick={close} />
          <div className="absolute top-full right-0 mt-2 w-80 overflow-hidden rounded-[6px] border border-black bg-white shadow-xl">
            {anyStreaming && (
              <div className="border-b border-neutral-200 bg-neutral-50 px-3 py-2 text-[12px] text-neutral-500">
                Wait for replies to finish before switching folders.
              </div>
            )}

            {naming ? (
              <NewFolderCard
                onDone={(vp) => {
                  close()
                  apply(vp)
                }}
                onCancel={() => setNaming(false)}
              />
            ) : (
              <>
                {/* Recents scroll; the create / open actions below stay pinned. */}
                <div className="max-h-[50vh] overflow-y-auto">
                  {folder.recents.map((r) => {
                    const isCurrent = r.path === folder.current
                    return (
                      <button
                        key={r.path}
                        type="button"
                        disabled={anyStreaming || isCurrent}
                        onClick={() => void handleSelect(r.path)}
                        className={`flex w-full items-center gap-2 px-3 py-2 text-left transition-colors ${
                          isCurrent ? '' : 'cursor-pointer hover:bg-neutral-100'
                        } ${anyStreaming && !isCurrent ? 'opacity-50' : ''}`}
                      >
                        <span
                          className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                            isCurrent ? 'bg-black' : 'bg-transparent'
                          }`}
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[13px] font-medium text-neutral-800">
                            {r.name}
                          </span>
                          <span className="block truncate text-[11px] text-neutral-400">
                            {r.path}
                          </span>
                        </span>
                        <span className="shrink-0 text-[11px] text-neutral-400">
                          {r.chatCount} chat{r.chatCount === 1 ? '' : 's'}
                        </span>
                      </button>
                    )
                  })}
                </div>
                <button
                  type="button"
                  disabled={anyStreaming}
                  onClick={() => setNaming(true)}
                  className={`flex w-full items-center gap-2 border-t border-neutral-200 px-3 py-2 text-left text-[13px] font-medium text-black transition-colors ${
                    anyStreaming ? 'opacity-50' : 'cursor-pointer hover:bg-neutral-100'
                  }`}
                >
                  <FolderPlus className="h-3.5 w-3.5 shrink-0" />
                  New Folder
                </button>
                <button
                  type="button"
                  disabled={anyStreaming}
                  onClick={() => void handleChoose()}
                  className={`w-full border-t border-neutral-200 px-3 py-2 text-left text-[13px] font-medium text-black transition-colors ${
                    anyStreaming ? 'opacity-50' : 'cursor-pointer hover:bg-neutral-100'
                  }`}
                >
                  Open another folder…
                </button>
              </>
            )}
          </div>
        </>
      )}
    </div>
  )
}
