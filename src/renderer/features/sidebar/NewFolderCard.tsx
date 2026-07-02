import { useEffect, useRef, useState } from 'react'
import type { Viewport } from '@xyflow/react'
import { useCanvasStore } from '@renderer/store/canvas'

/**
 * The inline "name a new folder" step: type a name, see (and optionally
 * change) where it lands, and Create — no native dialog. Shared by the
 * folder-chip dropdown and the empty-canvas state so the flow looks and
 * behaves identically in both places.
 */
export default function NewFolderCard({
  onDone,
  onCancel
}: {
  onDone: (vp: Viewport | null) => void
  onCancel: () => void
}): React.JSX.Element {
  const folder = useCanvasStore((s) => s.folder)
  const createFolder = useCanvasStore((s) => s.createFolder)
  const [name, setName] = useState('')
  const [parent, setParent] = useState<string | null>(null) // overrides folder.createParent when set
  const [busy, setBusy] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const dest = parent ?? folder?.createParent ?? ''
  const handleCreate = async (): Promise<void> => {
    if (!name.trim() || busy) return
    setBusy(true)
    const vp = await createFolder(name, parent ?? undefined)
    setBusy(false)
    onDone(vp)
  }
  const handlePickParent = async (): Promise<void> => {
    const picked = await window.api.folder.pickCreateParent()
    if (picked) setParent(picked)
    inputRef.current?.focus()
  }

  return (
    <div className="p-3">
      <input
        ref={inputRef}
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void handleCreate()
          if (e.key === 'Escape') onCancel()
        }}
        placeholder="Folder name"
        className="w-full rounded-[6px] border border-neutral-300 px-2.5 py-1.5 text-[13px] outline-none focus:border-black"
      />
      <div className="mt-2 flex items-baseline gap-1 text-[11px] text-neutral-400">
        <span className="shrink-0">in</span>
        <span className="min-w-0 flex-1 truncate" title={dest}>
          {dest}
        </span>
        <button
          type="button"
          onClick={() => void handlePickParent()}
          className="shrink-0 cursor-pointer font-medium text-neutral-600 hover:text-black"
        >
          Change…
        </button>
      </div>
      <div className="mt-3 flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="cursor-pointer rounded-[6px] px-2.5 py-1 text-[13px] text-neutral-600 hover:bg-neutral-100"
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={!name.trim() || busy}
          onClick={() => void handleCreate()}
          className="cursor-pointer rounded-[6px] bg-black px-3 py-1 text-[13px] font-medium text-white transition-colors hover:bg-neutral-800 disabled:cursor-default disabled:opacity-40"
        >
          Create
        </button>
      </div>
    </div>
  )
}
