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

// --- Widget frames (sandboxed iframes) --------------------------------------
// An iframe is an event boundary: wheels inside it never reach this window,
// and wheels outside never reach the iframe — which would snap momentum dead
// at the border in both directions. The bridge shim inside every widget
// reports its wheel activity here (noteWidgetWheel), and trusted parent
// activity is broadcast back into the frames, so gesture latching spans the
// boundary: a scroll that BEGAN inside a focused widget keeps scrolling that
// widget as the cursor drifts out (deltas piped back in via `apply`), and a
// pan that began outside stays a pan as the cursor crosses a widget (the
// shim forwards those instead of consuming them).
let widgetGesture: {
  el: HTMLElement
  apply: (dx: number, dy: number, mode: number) => void
} | null = null
// Installed by the widget-frames registry (avoids a lib → features import).
let broadcastExtWheel: (() => void) | null = null
let lastBroadcastTs = 0

export function setExtWheelBroadcaster(fn: () => void): void {
  broadcastExtWheel = fn
}

/** A widget's shim consumed a trusted wheel natively — latch a fresh gesture
 *  on that frame (never steal one already in flight). `apply` pipes follow-up
 *  deltas back into the frame when the cursor drifts outside mid-gesture. */
export function noteWidgetWheel(
  el: HTMLElement,
  apply: (dx: number, dy: number, mode: number) => void
): void {
  const now = performance.now()
  if (now - lastWheelTs > GESTURE_GAP_MS) {
    widgetGesture = { el, apply }
    gestureOwner = el
    gestureAxis = null
  }
  lastWheelTs = now
}

// Trusted wheel in the parent while a widget owns the live gesture: the
// cursor drifted out of the frame mid-scroll — keep feeding the widget
// instead of starting a canvas pan. Reads the pre-event lastWheelTs and
// swallows consumed events entirely, so it must run before trackGesture.
const routeWidgetGesture = (e: WheelEvent): void => {
  if (!e.isTrusted || !widgetGesture) return
  // Pinch (ctrl-wheel on macOS trackpads) and ⌘-wheel are always the canvas
  // zoom — never piped into a widget, and starting one ends the widget's
  // ownership so the zoom lands even mid-momentum.
  if (e.ctrlKey || e.metaKey) {
    widgetGesture = null
    return
  }
  if (performance.now() - lastWheelTs > GESTURE_GAP_MS) {
    widgetGesture = null // that gesture ended; this event starts a fresh one
    return
  }
  e.preventDefault()
  e.stopImmediatePropagation()
  lastWheelTs = performance.now()
  widgetGesture.apply(e.deltaX, e.deltaY, e.deltaMode)
}

const trackGesture = (e: WheelEvent): void => {
  // Clones re-dispatched onto the pane by forwardToPane are untrusted — they
  // are part of an already-tracked gesture, not a new one.
  if (!e.isTrusted) return
  const now = performance.now()
  if (now - lastWheelTs > GESTURE_GAP_MS) {
    const target = e.target instanceof Node ? e.target : null
    gestureOwner = (target && [...regions].find((r) => r.contains(target))) || 'pane'
    gestureAxis = null
    widgetGesture = null // a gesture starting out here is never widget-owned
  }
  lastWheelTs = now
  // Tell widget frames an external gesture is live, so momentum drifting
  // over a focused widget forwards back out instead of hijacking mid-flight.
  if (broadcastExtWheel && now - lastBroadcastTs > 80) {
    lastBroadcastTs = now
    broadcastExtWheel()
  }
}

// The window capture listeners exist only while something needs them —
// refcounted, since both scroll regions and widget frames retain them.
let tracking = 0
export function retainWheelTracking(): () => void {
  if (tracking++ === 0) {
    // Order matters: routeWidgetGesture must see the pre-event lastWheelTs
    // and stopImmediatePropagation()s what it consumes — register it first.
    window.addEventListener('wheel', routeWidgetGesture, { capture: true, passive: false })
    window.addEventListener('wheel', trackGesture, { capture: true, passive: true })
  }
  let released = false
  return () => {
    if (released) return
    released = true
    if (--tracking === 0) {
      window.removeEventListener('wheel', routeWidgetGesture, { capture: true })
      window.removeEventListener('wheel', trackGesture, { capture: true })
    }
  }
}

function registerRegion(el: HTMLElement): () => void {
  const release = retainWheelTracking()
  regions.add(el)
  return () => {
    regions.delete(el)
    release()
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
