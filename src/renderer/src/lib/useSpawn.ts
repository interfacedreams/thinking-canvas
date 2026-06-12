import { useCallback } from 'react'
import { useCanvasStore } from '../store/canvas'

/**
 * Arm placement mode for a chat, note, or file: a ghost node sticks to the
 * cursor and the next canvas click places it (PlacementOverlay handles that
 * part). Re-arming the same kind disarms — the buttons and C / N / F keys
 * toggle. Files first detour through the image/PDF picker; the ghost arms
 * only once something was actually picked.
 */
export function useSpawn(): (kind: 'chat' | 'note' | 'file') => void {
  const setPlacing = useCanvasStore((s) => s.setPlacing)
  const startFilePlacement = useCanvasStore((s) => s.startFilePlacement)

  return useCallback(
    (kind) => {
      const { folder, placing } = useCanvasStore.getState()
      if (!folder?.current) return
      if (placing === kind) {
        setPlacing(null)
      } else if (kind === 'file') {
        void startFilePlacement()
      } else {
        setPlacing(kind)
      }
    },
    [setPlacing, startFilePlacement]
  )
}
