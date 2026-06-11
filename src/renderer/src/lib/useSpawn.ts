import { useCallback } from 'react'
import { useCanvasStore } from '../store/canvas'

/**
 * Arm placement mode for a chat or note: a ghost node sticks to the cursor
 * and the next canvas click places it (PlacementOverlay handles that part).
 * Re-arming the same kind disarms — the buttons and C / N keys toggle.
 * Shared by the new-chat/new-note buttons and the C / N / ⌘N shortcuts.
 */
export function useSpawn(): (kind: 'chat' | 'note') => void {
  const setPlacing = useCanvasStore((s) => s.setPlacing)

  return useCallback(
    (kind) => {
      const { folder, placing } = useCanvasStore.getState()
      if (!folder?.current) return
      setPlacing(placing === kind ? null : kind)
    },
    [setPlacing]
  )
}
