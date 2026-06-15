import { useCallback } from 'react'
import { useCanvasStore, type PanelMode } from '../store/canvas'

/**
 * Out-of-card docking for one node. A node can open right-docked ('panel') or
 * window-covering ('full'); both render the same body in ExpandedPanel, so its
 * canvas card shows a stub either way. `open(mode)` toggles: clicking the chip
 * for the current mode closes it, clicking the other mode's chip flips to it
 * (no remount — same ExpandedPanel, only the container resizes). Esc and the
 * panel's own chips route through these same store actions.
 */
export function usePanel(id: string): {
  docked: boolean
  mode: PanelMode | null
  open: (mode: PanelMode) => void
  collapse: () => void
  stubAction: () => void
} {
  // Active (mounted) mode, or null when this node isn't the one on screen.
  const activeMode = useCanvasStore((s) => (s.expanded?.id === id ? s.expanded.mode : null))
  // A backgrounded tab in the browsing strip is also "docked" — its card shows
  // a stub so its webview is never mounted twice (a guest can live in one spot).
  const inStrip = useCanvasStore((s) => s.expanded?.id !== id && s.panelTabs.includes(id))
  const open = useCallback(
    (next: PanelMode) => {
      const s = useCanvasStore.getState()
      if (s.expanded?.id === id && s.expanded.mode === next) s.collapseExpanded()
      else s.expandNode(id, next)
    },
    [id]
  )
  const collapse = useCallback(() => useCanvasStore.getState().collapseExpanded(), [])
  // Clicking a node's docked stub: bring a backgrounded strip tab to the front;
  // otherwise (the active node) just close the panel.
  const stubAction = useCallback(() => {
    const s = useCanvasStore.getState()
    if (s.expanded?.id !== id && s.panelTabs.includes(id)) s.expandNode(id, 'panel')
    else s.collapseExpanded()
  }, [id])
  return {
    docked: activeMode !== null || inStrip,
    mode: activeMode ?? (inStrip ? 'panel' : null),
    open,
    collapse,
    stubAction
  }
}
