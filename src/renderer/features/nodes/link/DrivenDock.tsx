import { useEffect, useLayoutEffect, useReducer, useRef, useSyncExternalStore } from 'react'
import type { RefObject } from 'react'
import { useViewport } from '@xyflow/react'
import { dockSlots } from '@renderer/features/nodes/link/dockSlots'

// A driven tab must be FULLY inside the window for computer use to see it.
// Blink renders a <webview> guest only where its element intersects the
// viewport (plus a hard-coded 15% margin — RemoteFrameView::ComputeCompositing
// Rect, no opt-out), and capturePage crops to the on-screen part: a tab
// hanging 10% off the edge screenshots as a cropped sliver with misaligned
// click coordinates, and a fully offscreen tab stops rendering entirely so
// every capture path hangs (electron#29113). So while a turn drives this tab
// and any of it is out of view, counter-transform its body into a bottom-right
// picture-in-picture. Docked tabs form a grid: first upward from the corner,
// then wrapping into columns leftward (slot order in dockSlots). CSS
// transforms don't change layout, so the guest's viewport — and the turn's
// screenshot geometry and click coordinates — are untouched; and because the
// transform rides on the overflow-hidden body itself (not a descendant), no
// ancestor clips it. Mounted only while the tab is driven; unmounting
// releases the slot and restores the body.

const DOCK_W = 320 // grid cell width, on-screen px
const CELL_H = 224 // grid cell height — tabs scale to fit within the cell
const GAP = 12
const MARGIN = 16

export default function DrivenDock({
  id,
  bodyRef
}: {
  id: string
  bodyRef: RefObject<HTMLDivElement | null>
}): null {
  const viewport = useViewport() // re-renders on every pan/zoom so the pin tracks
  const [, bump] = useReducer((c: number) => c + 1, 0)
  // Subscribing re-renders this dock when any other dock claims/releases a
  // slot, so the grid compacts live (the layout effect re-reads the index).
  useSyncExternalStore(dockSlots.subscribe, () => dockSlots.index(id))
  const dockedRef = useRef(false)

  useEffect(() => {
    window.addEventListener('resize', bump)
    return () => window.removeEventListener('resize', bump)
  }, [])

  useLayoutEffect(() => {
    const el = bodyRef.current
    const nodeEl = el?.closest('.react-flow__node')
    if (!el || !nodeEl) return
    const zoom = viewport.zoom
    // The body's natural (undocked) screen rect, measured transform-
    // independently: the node wrapper's rect is clean (our transform sits
    // below it), and offset* values are layout-space, immune to transforms.
    const nr = nodeEl.getBoundingClientRect()
    let offX = 0
    let offY = 0
    for (
      let e: HTMLElement | null = el;
      e && e !== nodeEl;
      e = e.offsetParent instanceof HTMLElement ? e.offsetParent : null
    ) {
      offX += e.offsetLeft
      offY += e.offsetTop
    }
    const sx = nr.x + offX * zoom
    const sy = nr.y + offY * zoom
    const sw = el.offsetWidth * zoom
    const sh = el.offsetHeight * zoom

    // Hidden fraction per axis of the natural rect. Any clipping at all
    // corrupts screenshots (cropped image, shifted coordinates), so dock on
    // more than a sliver and undock only when fully back in view.
    const winW = window.innerWidth
    const winH = window.innerHeight
    const hiddenX = Math.max(0, -sx) + Math.max(0, sx + sw - winW)
    const hiddenY = Math.max(0, -sy) + Math.max(0, sy + sh - winH)
    const hiddenFrac = sw <= 0 || sh <= 0 ? 0 : Math.max(hiddenX / sw, hiddenY / sh)
    const docked = dockedRef.current ? hiddenFrac > 0 : hiddenFrac > 0.005

    // Ease the jump between natural and docked positions — but only for the
    // toggle itself: while docked, the transform recomputes every pan/zoom
    // frame to hold the pin, and a lingering transition would make it swim.
    if (docked !== dockedRef.current) {
      dockedRef.current = docked
      el.style.transition = 'transform 240ms ease, box-shadow 240ms ease'
      window.setTimeout(() => {
        el.style.transition = ''
      }, 260)
    }

    if (!docked) {
      dockSlots.release(id)
      el.style.transform = ''
      el.style.transformOrigin = ''
      el.style.boxShadow = ''
      return
    }

    dockSlots.claim(id)
    const idx = Math.max(0, dockSlots.index(id))
    const rows = Math.max(1, Math.floor((winH - MARGIN) / (CELL_H + GAP)))
    const col = Math.floor(idx / rows)
    const row = idx % rows
    const k = Math.min(1, DOCK_W / sw, CELL_H / sh)
    const dw = sw * k
    const dh = sh * k
    // Anchor each tab to the bottom-right of its cell.
    const px = winW - MARGIN - col * (DOCK_W + GAP) - dw
    const py = winH - MARGIN - row * (CELL_H + GAP) - dh
    // Local-space transform: ancestors scale by `zoom`, so a local translate
    // of d moves the element zoom*d px on screen.
    el.style.transformOrigin = '0 0'
    el.style.transform = `translate(${(px - sx) / zoom}px, ${(py - sy) / zoom}px) scale(${k})`
    el.style.boxShadow = '0 12px 40px rgba(0,0,0,0.35)'
  })

  useEffect(
    () => () => {
      dockSlots.release(id)
      dockedRef.current = false
      const el = bodyRef.current
      if (el) {
        el.style.transform = ''
        el.style.transformOrigin = ''
        el.style.boxShadow = ''
        el.style.transition = ''
      }
    },
    [id, bodyRef]
  )

  return null
}
