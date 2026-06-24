import { useState } from 'react'
import { useReactFlow, type Viewport } from '@xyflow/react'
import { FolderPlus } from 'lucide-react'
import { useCanvasStore } from '../store/canvas'
import CanvasMark from './CanvasMark'
import NewFolderCard from './NewFolderCard'

/**
 * Shown when no folder is open yet: pick an existing folder, or start a new
 * one. "New Folder" flips into the same inline naming step as the folder-chip
 * dropdown ([[NewFolderCard]]) so the flow looks identical wherever it's offered.
 */
export default function EmptyFolderState(): React.JSX.Element {
  const chooseFolder = useCanvasStore((s) => s.chooseFolder)
  const { setViewport } = useReactFlow()
  const [naming, setNaming] = useState(false)

  const apply = (vp: Viewport | null): void => {
    if (vp) void setViewport(vp)
  }
  const handleChoose = async (): Promise<void> => {
    apply(await chooseFolder())
  }

  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-4">
      <CanvasMark className="h-16 w-16" />
      <p className="text-[15px] text-[#92690B]">Pick a folder to start a canvas</p>
      {naming ? (
        <div className="w-80 overflow-hidden rounded-[6px] border border-black bg-white shadow-xl">
          <NewFolderCard
            onDone={(vp) => {
              setNaming(false)
              apply(vp)
            }}
            onCancel={() => setNaming(false)}
          />
        </div>
      ) : (
        <div className="flex flex-col items-stretch gap-2">
          <button
            type="button"
            onClick={() => void handleChoose()}
            className="cursor-pointer rounded-[14px] border border-[#EDD27E] bg-[#FEF3C7] px-4 py-2 text-[14px] font-medium text-[#92690B] shadow-lg transition-colors hover:bg-[#FDE68A] active:scale-95"
          >
            Open folder…
          </button>
          <button
            type="button"
            onClick={() => setNaming(true)}
            className="flex cursor-pointer items-center justify-center gap-2 rounded-[14px] border border-[#EDD27E] bg-[#FEF3C7] px-4 py-2 text-[14px] font-medium text-[#92690B] shadow-lg transition-colors hover:bg-[#FDE68A] active:scale-95"
          >
            <FolderPlus className="h-3.5 w-3.5 shrink-0" />
            New Folder
          </button>
        </div>
      )}
    </div>
  )
}
