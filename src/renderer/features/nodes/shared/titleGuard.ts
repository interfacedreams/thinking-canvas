import { useEffect, useRef } from 'react'
import { useCanvasStore } from '@renderer/store/canvas'

// Tooltip shown when the warning sign is hovered.
export const DUPLICATE_TITLE_HINT = 'Cannot have duplicate titles'

// Does another node already wear this title? Trimmed + case-insensitive, and a
// blank title never counts (untitled nodes are allowed to pile up).
function titleTaken(id: string, title: string): boolean {
  const t = title.trim().toLowerCase()
  if (!t) return false
  return useCanvasStore
    .getState()
    .nodes.some((n) => n.id !== id && (n.data.title ?? '').trim().toLowerCase() === t)
}

export interface TitleGuard {
  // The in-progress title collides with another node — block the save.
  duplicate: boolean
  // Drop the typed-but-rejected title back to what it was when editing opened.
  revert: () => void
}

// Shared rename guard for every node header. While renaming, flags a duplicate
// (so the view can show a warning and refuse to commit) and can restore the
// title the node had when editing began — for when the user blurs or escapes
// out of a colliding name instead of fixing it.
export function useTitleGuard(id: string, editingTitle: boolean, currentTitle: string): TitleGuard {
  const setTitle = useCanvasStore((s) => s.setTitle)
  const originalRef = useRef(currentTitle)
  // Snapshot the title the moment rename mode opens (not on every keystroke);
  // read it from the store so the captured value never goes stale.
  useEffect(() => {
    if (!editingTitle) return
    const node = useCanvasStore.getState().nodes.find((n) => n.id === id)
    originalRef.current = node?.data.title ?? ''
  }, [editingTitle, id])

  return {
    duplicate: editingTitle && titleTaken(id, currentTitle),
    revert: () => setTitle(id, originalRef.current)
  }
}
