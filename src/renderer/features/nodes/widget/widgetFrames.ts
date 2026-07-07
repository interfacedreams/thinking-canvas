// Live widget iframes by node id — registered by WidgetNodeView and
// InlineWidget, the inbound half of the message bus (mirrors pageText's
// guests map for tabs). A minimized widget unmounts its frame, so it has no
// entry and inbound pushes are simply dropped; the widget re-renders from its
// HTML when it remounts.

import { retainWheelTracking, setExtWheelBroadcaster } from '@renderer/lib/useForwardedWheel'

const frames = new Map<string, HTMLIFrameElement>()
const releases = new Map<HTMLIFrameElement, () => void>()

// Cross-boundary gesture latching (see useForwardedWheel): tell every live
// frame's shim that a trusted wheel gesture is running out here, so momentum
// drifting over a focused widget forwards back out instead of hijacking.
setExtWheelBroadcaster(() => {
  for (const el of frames.values()) {
    try {
      el.contentWindow?.postMessage({ __widgetIn: true, type: '__extWheel' }, '*')
    } catch {
      // frame mid-teardown
    }
  }
})

export function registerWidgetFrame(id: string, el: HTMLIFrameElement): void {
  frames.set(id, el)
  // Widget frames need the window gesture tracker alive even with no
  // scrollable regions mounted.
  releases.set(el, retainWheelTracking())
}

export function unregisterWidgetFrame(id: string, el: HTMLIFrameElement): void {
  if (frames.get(id) === el) frames.delete(id)
  releases.get(el)?.()
  releases.delete(el)
}

/** Is this window one of our live widget frames? The outbound message
 *  listener uses it to attribute a postMessage to its widget node. */
export function widgetIdForSource(source: MessageEventSource | null): string | null {
  if (!source) return null
  for (const [id, el] of frames) {
    if (el.contentWindow === source) return id
  }
  return null
}

/** Push a message into a widget's sandbox — dispatched to its
 *  canvas.on(type) handlers by the bridge shim. '*' is required: the frame is
 *  an opaque origin (sandbox without allow-same-origin). */
export function postToWidget(id: string, type: string, payload: unknown): void {
  const win = frames.get(id)?.contentWindow
  if (!win) return
  try {
    win.postMessage({ __widgetIn: true, type, payload }, '*')
  } catch {
    // frame mid-teardown — nothing to deliver to
  }
}
