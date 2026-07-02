import { useEffect, useRef, useState } from 'react'
import { useCanvasStore, forkSubtree, isFile, isLink, isNote } from '@renderer/store/canvas'

function Dialog({ pendingId }: { pendingId: string }): React.JSX.Element {
  const cancelDelete = useCanvasStore((s) => s.cancelDelete)
  const deleteChat = useCanvasStore((s) => s.deleteChat)
  const title = useCanvasStore((s) => s.nodes.find((n) => n.id === pendingId)?.data.title ?? '')
  const kind = useCanvasStore((s) => {
    const n = s.nodes.find((n) => n.id === pendingId)
    return n && isNote(n) ? 'note' : n && isFile(n) ? 'image' : n && isLink(n) ? 'tab' : 'chat'
  })
  const note = kind === 'note'
  // Only chats fork, so notes and images never have a subtree to cascade into.
  const forkCount = useCanvasStore((s) =>
    kind === 'chat' ? forkSubtree(s.edges, pendingId).size - 1 : 0
  )

  // "Delete forked chats" is a per-use choice — the dialog is keyed by chat id,
  // so this state mounts fresh (unchecked) every time the modal opens.
  const [cascade, setCascade] = useState(false)

  // Focus the Delete button on open so Enter confirms immediately. autoFocus is
  // unreliable here: the trash chip that opened the dialog still holds focus, so
  // we claim it explicitly once the dialog has mounted.
  const deleteRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    deleteRef.current?.focus()
  }, [])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') cancelDelete()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [cancelDelete])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30"
      onClick={cancelDelete}
    >
      <div
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
        className="w-[360px] rounded-[14px] border border-black/10 bg-white p-5 shadow-xl"
      >
        <h2 className="text-[15px] font-semibold text-neutral-900">Delete this {kind}?</h2>
        <p className="mt-1.5 text-[13px] leading-relaxed text-neutral-600">
          {kind === 'image' ? (
            <>
              {title ? <>“{title}”</> : 'This image'} will be removed from the canvas. The image
              file stays in your folder.
            </>
          ) : kind === 'tab' ? (
            <>{title ? <>“{title}”</> : 'This tab'} will be removed from the canvas.</>
          ) : (
            <>
              {title ? (
                <>
                  “{title}” and its {note ? 'file' : 'messages'}
                </>
              ) : (
                <>This {kind}</>
              )}{' '}
              will be removed from the canvas. This can’t be undone.
            </>
          )}
        </p>

        {forkCount > 0 && (
          <label className="mt-3 flex cursor-pointer items-center gap-2 text-[13px] text-neutral-800 select-none">
            <input
              type="checkbox"
              checked={cascade}
              onChange={(e) => setCascade(e.target.checked)}
              className="h-4 w-4 accent-red-600"
            />
            Delete forked chats ({forkCount})
          </label>
        )}

        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={cancelDelete}
            className="cursor-pointer rounded-[10px] border border-neutral-200 bg-white px-3 py-1.5 text-[13px] font-medium text-neutral-700 transition-colors hover:bg-neutral-100"
          >
            Cancel
          </button>
          <button
            ref={deleteRef}
            type="button"
            onClick={() => deleteChat(pendingId, cascade)}
            className="cursor-pointer rounded-[10px] bg-red-600 px-3 py-1.5 text-[13px] font-medium text-white transition-colors hover:bg-red-700 active:scale-95"
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  )
}

/** Confirmation dialog for deleting a chat (and, optionally, its forks). */
export default function DeleteChatModal(): React.JSX.Element | null {
  const pendingId = useCanvasStore((s) => s.pendingDeleteId)
  if (!pendingId) return null
  return <Dialog key={pendingId} pendingId={pendingId} />
}
