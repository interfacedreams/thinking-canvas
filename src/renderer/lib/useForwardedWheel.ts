import { useEffect, useRef, type RefObject } from 'react'

// --- Gesture latching, shared across every forwarded region -----------------
//
// A wheel "gesture" is a run of events with gaps under GESTURE_GAP_MS (trackpad
// streams and their momentum tail arrive far faster than this). The gesture is
// owned by whatever was under the cursor when it began — same rule macOS and
// browsers use for native scroll latching. Ownership is decided once, at the
// first event of a gesture, and never re-evaluated mid-flight: a canvas pan
// that slides a transcript under the stationary cursor must NOT get hijacked
// by it, and a transcript scroll that moves the node must not leak out.

const GESTURE_GAP_MS = 200

const regions = new Set<HTMLElement>()
let lastWheelTs = 0
let gestureOwner: HTMLElement | 'pane' = 'pane'
// Axis lock for the current gesture. Once a region has scrolled its content
// vertically, the gesture is committed to the vertical axis: the sideways
// drift trackpads emit mid-scroll must not leak out as a canvas pan. Set by
// the owning region, reset when a new gesture begins.
let gestureAxis: 'vertical' | null = null

const trackGesture = (e: WheelEvent): void => {
  // Clones re-dispatched onto the pane by forwardToPane are untrusted — they
  // are part of an already-tracked gesture, not a new one.
  if (!e.isTrusted) return
  const now = performance.now()
  if (now - lastWheelTs > GESTURE_GAP_MS) {
    const target = e.target instanceof Node ? e.target : null
    gestureOwner = (target && [...regions].find((r) => r.contains(target))) || 'pane'
    gestureAxis = null
  }
  lastWheelTs = now
}

// The window capture listener exists only while at least one region is live.
function registerRegion(el: HTMLElement): () => void {
  if (regions.size === 0) {
    window.addEventListener('wheel', trackGesture, { capture: true, passive: true })
  }
  regions.add(el)
  return () => {
    regions.delete(el)
    if (regions.size === 0) {
      window.removeEventListener('wheel', trackGesture, { capture: true })
    }
  }
}

/**
 * Wheel routing for a scrollable region inside a React Flow node (the region
 * itself must carry the `nowheel` class). Scrolling is focus-gated: only a
 * *focused* node (clicked / selected) scrolls its own content — over an
 * unfocused node every wheel pans the canvas, so reading the board never
 * fights with reading a transcript.
 *
 * While focused, the wheel is captured by the region: vertical scrolls the
 * transcript (stopping dead at the edges instead of slingshotting into a
 * canvas pan), horizontal scrolls an overflowing child (e.g. a code block) if
 * one is under the cursor. ⌘/ctrl+wheel and pinch always reach the canvas
 * (zoom), as do gestures latched elsewhere (a pan passing through) and any
 * wheel over a region with nothing to scroll.
 *
 * `enabled` should flip when the scroll element mounts/unmounts (the effect
 * can't see ref.current changes on its own). `onScrollUp` fires on upward
 * wheels the region itself owns — chat transcripts use it to release
 * auto-follow.
 */
export function useForwardedWheel(
  ref: RefObject<HTMLDivElement | null>,
  enabled: boolean,
  focused: boolean,
  onScrollUp?: () => void
): void {
  const onScrollUpRef = useRef(onScrollUp)
  useEffect(() => {
    onScrollUpRef.current = onScrollUp
  })

  useEffect(() => {
    const el = ref.current
    if (!el || !enabled) return
    const unregister = registerRegion(el)
    const forwardToPane = (e: WheelEvent): void => {
      e.preventDefault()
      e.stopPropagation()
      const pane = el.closest('.react-flow')?.querySelector('.react-flow__pane')
      pane?.dispatchEvent(
        new WheelEvent('wheel', {
          deltaX: e.deltaX,
          deltaY: e.deltaY,
          deltaMode: e.deltaMode,
          clientX: e.clientX,
          clientY: e.clientY,
          ctrlKey: e.ctrlKey,
          metaKey: e.metaKey,
          bubbles: true,
          cancelable: true
        })
      )
    }
    // Swallow the event entirely: the focused region owns it but has nowhere
    // to put it (at an edge, or sideways with no scrollable child) — it must
    // not leak out as a canvas pan.
    const consume = (e: WheelEvent): void => {
      e.preventDefault()
      e.stopPropagation()
    }
    // True if something between the wheel target and the region (e.g. an
    // overflowing code block) can still scroll horizontally in this direction.
    const childCanScrollX = (e: WheelEvent): boolean => {
      let node = e.target instanceof HTMLElement ? e.target : null
      while (node && node !== el) {
        const { overflowX } = getComputedStyle(node)
        if (
          (overflowX === 'auto' || overflowX === 'scroll') &&
          node.scrollWidth > node.clientWidth + 1 &&
          (e.deltaX > 0
            ? node.scrollLeft + node.clientWidth < node.scrollWidth - 1
            : node.scrollLeft > 0)
        ) {
          return true
        }
        node = node.parentElement
      }
      return false
    }
    const onWheel = (e: WheelEvent): void => {
      if (e.metaKey || e.ctrlKey) {
        forwardToPane(e)
        return
      }
      // Unfocused: the node is just furniture — every wheel pans the canvas.
      if (!focused) {
        forwardToPane(e)
        return
      }
      // Latched elsewhere: a gesture that began on the canvas (or another
      // node) stays a canvas pan even while this region is under the cursor.
      if (gestureOwner !== el) {
        forwardToPane(e)
        return
      }
      if (e.deltaY < 0) onScrollUpRef.current?.()
      // Mostly-horizontal: scroll an overflowing code block if one is under
      // the cursor; otherwise nothing here scrolls sideways. Once this gesture
      // has committed to vertical scrolling, swallow the sideways drift so it
      // never leaks out as a canvas pan; only an axis-undecided gesture is free
      // to pan.
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) {
        if (childCanScrollX(e)) return
        if (gestureAxis === 'vertical') consume(e)
        else forwardToPane(e)
        return
      }
      const canScroll = el.scrollHeight - el.clientHeight > 1
      if (!canScroll) {
        // Nothing to scroll inside — panning is the only sensible response.
        forwardToPane(e)
        return
      }
      // We're about to scroll the content vertically — commit the gesture to
      // the vertical axis so later sideways drift stays trapped here.
      gestureAxis = 'vertical'
      const atEdge =
        e.deltaY < 0 ? el.scrollTop <= 0 : el.scrollHeight - el.scrollTop - el.clientHeight <= 1
      if (atEdge) consume(e)
      // Otherwise fall through to the native scroll.
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      el.removeEventListener('wheel', onWheel)
      unregister()
    }
  }, [ref, enabled, focused])
}
