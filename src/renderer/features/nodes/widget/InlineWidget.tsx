import { memo, useEffect, useRef } from 'react'
import { useCanvasStore } from '@renderer/store/canvas'
import {
  registerWidgetFrame,
  unregisterWidgetFrame,
  widgetIdForSource
} from '@renderer/features/nodes/widget/widgetFrames'
import { noteWidgetWheel } from '@renderer/lib/useForwardedWheel'

// The transcript-embedded sibling of WidgetNodeView (show_inline_widget): the
// same widget:// document in the same sandbox, mounted inside a chat message
// instead of its own canvas card. No node, no edges — its chat IS its one
// counterparty, so `prompt` routes straight to the hosting chat and
// canvas.fetch brokers against the widget's own file header, same as a card.

const DEFAULT_H = 260
const MIN_H = 80
const MAX_H = 800

const MSG_WINDOW_MS = 2_000
const MSG_WINDOW_MAX = 20
const FETCH_WINDOW_MS = 10_000
const FETCH_WINDOW_MAX = 10

function InlineWidget({
  chatId,
  widgetId,
  height
}: {
  chatId: string
  widgetId: string
  height?: number
}): React.JSX.Element {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)

  // Focus gating, transcript flavor: the shim blocks wheel until the block is
  // clicked; blocked wheels arrive here and scroll the transcript (or pan the
  // canvas when the chat itself isn't focused) — hovering an inline block
  // must never hijack the scroll. Clicking anywhere outside re-locks it;
  // clicks inside the iframe never reach this window, so only outside clicks
  // fire this listener.
  useEffect(() => {
    const el = iframeRef.current
    if (!el) return
    const lock = (): void => {
      el.contentWindow?.postMessage({ __widgetIn: true, type: '__focus', payload: false }, '*')
    }
    window.addEventListener('pointerdown', lock, { capture: true })
    el.addEventListener('load', lock)
    return () => {
      window.removeEventListener('pointerdown', lock, { capture: true })
      el.removeEventListener('load', lock)
    }
  }, [])

  useEffect(() => {
    const el = iframeRef.current
    if (!el) return
    // Registered under its widgetId so set_widget_data reaches inline blocks too.
    registerWidgetFrame(widgetId, el)
    const stamps: number[] = []
    const fetchStamps: number[] = []
    const allow = (window: number[], ms: number, max: number): boolean => {
      const now = Date.now()
      while (window.length > 0 && now - window[0] > ms) window.shift()
      if (window.length >= max) return false
      window.push(now)
      return true
    }
    const onMessage = (e: MessageEvent): void => {
      if (widgetIdForSource(e.source) !== widgetId) return
      if (e.source !== el.contentWindow) return
      const d = e.data as {
        __widget?: unknown
        msg?: unknown
        fetch?: unknown
        focused?: unknown
        wheel?: unknown
        wheelUsed?: unknown
      } | null
      if (!d || d.__widget !== true) return
      // The shim consumed a wheel natively — latch the gesture on this frame
      // so momentum drifting out keeps scrolling the block, not the canvas.
      if (d.wheelUsed === true) {
        noteWidgetWheel(el, (dx, dy, mode) => {
          el.contentWindow?.postMessage(
            { __widgetIn: true, type: '__scroll', payload: { dx, dy, mode } },
            '*'
          )
        })
        return
      }
      // Click inside the block: the shim already unlocked itself; there is no
      // node to select for an inline widget, so nothing more to do here.
      if (d.focused === true) return
      // Blocked wheel from the shim: scroll the transcript this block sits in
      // when the chat is focused (and scrollable), otherwise pan the canvas —
      // the same routing the transcript itself uses. In the docked panel
      // (no React Flow ancestor) the transcript is the only scroll target.
      const w = d.wheel as {
        dx?: unknown
        dy?: unknown
        mode?: unknown
        ctrl?: unknown
        meta?: unknown
      } | null
      if (w && typeof w.dy === 'number' && typeof w.dx === 'number') {
        const wrap = wrapRef.current
        if (!wrap) return
        // Pinch (ctrl-wheel) / ⌘-wheel is always the canvas zoom — never a
        // transcript scroll.
        const pinch = w.ctrl === true || w.meta === true
        const dy = (typeof w.mode === 'number' && w.mode === 1 ? 16 : 1) * w.dy
        const scroller = wrap.closest('.transcript-scroll')
        const pane = wrap.closest('.react-flow')?.querySelector('.react-flow__pane')
        const chatFocused = !!useCanvasStore.getState().nodes.find((n) => n.id === chatId)?.selected
        const scrollable = scroller && scroller.scrollHeight - scroller.clientHeight > 1
        if (!pinch && scrollable && (chatFocused || !pane)) {
          scroller.scrollTop += dy
        } else if (pane) {
          const rect = wrap.getBoundingClientRect()
          pane.dispatchEvent(
            new WheelEvent('wheel', {
              deltaX: w.dx,
              deltaY: w.dy,
              deltaMode: typeof w.mode === 'number' ? w.mode : 0,
              clientX: rect.left + rect.width / 2,
              clientY: rect.top + rect.height / 2,
              ctrlKey: w.ctrl === true,
              metaKey: w.meta === true,
              bubbles: true,
              cancelable: true
            })
          )
        }
        return
      }
      const f = d.fetch as { id?: unknown; url?: unknown } | undefined
      if (f && typeof f.id === 'number' && typeof f.url === 'string') {
        const fetchId = f.id
        const fail = (error: string): void => {
          el.contentWindow?.postMessage({ __widgetIn: true, fetchId, error }, '*')
        }
        if (!allow(fetchStamps, FETCH_WINDOW_MS, FETCH_WINDOW_MAX)) {
          fail('canvas.fetch rate limit exceeded')
          return
        }
        void window.api.widget
          .fetch(widgetId, f.url)
          .then((res) => {
            if (res.error) fail(res.error)
            else
              el.contentWindow?.postMessage(
                { __widgetIn: true, fetchId, status: res.status ?? 0, body: res.body ?? '' },
                '*'
              )
          })
          .catch((err) => fail(String(err)))
        return
      }
      const msg = d.msg as { type?: unknown; text?: unknown } | undefined
      if (!msg || msg.type !== 'prompt' || typeof msg.text !== 'string') return
      if (!allow(stamps, MSG_WINDOW_MS, MSG_WINDOW_MAX)) return
      const text = msg.text.trim().slice(0, 8_000)
      if (!text) return
      // Prompt goes to the hosting chat — the same borrow-the-composer dance
      // as the node router (park the user's half-typed draft, send, restore).
      const s = useCanvasStore.getState()
      const chat = s.nodes.find((n) => n.id === chatId)
      if (!chat || chat.data.status === 'streaming') return
      const parked = typeof chat.data.draft === 'string' ? chat.data.draft : ''
      s.setDraft(chatId, text)
      s.send(chatId)
      if (parked.trim()) s.setDraft(chatId, parked)
    }
    window.addEventListener('message', onMessage)
    return () => {
      window.removeEventListener('message', onMessage)
      unregisterWidgetFrame(widgetId, el)
    }
  }, [chatId, widgetId])

  const h = Math.min(MAX_H, Math.max(MIN_H, height ?? DEFAULT_H))
  return (
    <div
      ref={wrapRef}
      className="nodrag nowheel mb-2 overflow-hidden rounded-[10px] border border-black/10"
      style={{ height: h }}
    >
      <iframe
        ref={iframeRef}
        src={`widget://${widgetId}/`}
        sandbox="allow-scripts"
        title="Inline widget"
        className="h-full w-full border-0"
        style={{ backgroundColor: '#FFFDF6' }}
      />
    </div>
  )
}

export default memo(InlineWidget)
