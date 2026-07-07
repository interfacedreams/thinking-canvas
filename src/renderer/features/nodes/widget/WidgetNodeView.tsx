import { memo, useEffect, useRef, useState } from 'react'
import {
  Handle,
  NodeResizeControl,
  Position,
  ResizeControlVariant,
  type NodeProps
} from '@xyflow/react'
import { Minus, Plus, RotateCw, Trash2 } from 'lucide-react'
import { useCanvasStore, MAX_NODE_H, type WidgetNode } from '@renderer/store/canvas'
import { paletteFor } from '@renderer/lib/palette'
import Tooltip from '@renderer/ui/Tooltip'
import {
  CHIP_BUTTON,
  CTX_HANDLE_ID,
  ctxHandleStyle,
  ctxTargetStyle,
  OUTPUT_HANDLE_ID,
  DRAG_HEADER,
  HIDDEN_HANDLE
} from '@renderer/features/nodes/shared/nodeChrome'
import { useTitleGuard } from '@renderer/features/nodes/shared/titleGuard'
import TitleEditSlot from '@renderer/features/nodes/shared/TitleEditSlot'
import {
  registerWidgetFrame,
  unregisterWidgetFrame,
  widgetIdForSource
} from '@renderer/features/nodes/widget/widgetFrames'
import { noteWidgetWheel } from '@renderer/lib/useForwardedWheel'

// Same paper fill as notes/files — shows behind the iframe while it loads.
const PAPER = '#FFFDF6'

const RESIZE_LIMITS = { minWidth: 280, minHeight: 200, maxHeight: MAX_NODE_H }

// Rate limit for outbound widget messages: a runaway setInterval in generated
// JS must not spam sends into connected chats/tabs. Sliding window per frame.
const MSG_WINDOW_MS = 2_000
const MSG_WINDOW_MAX = 20
// canvas.fetch is brokered through main — cheaper to abuse, so its own window.
const FETCH_WINDOW_MS = 10_000
const FETCH_WINDOW_MAX = 10

/**
 * An AI-authored HTML card. The document is served by the widget:// protocol
 * (strict CSP, bridge shim injected) and rendered in a sandboxed iframe —
 * allow-scripts only, NO allow-same-origin, so the widget runs in an opaque
 * origin with no access to the app. Its only voice is window.canvas.send()
 * (postMessage), validated here and routed along the node's edges.
 */
function WidgetNodeView({ id, data, selected }: NodeProps<WidgetNode>): React.JSX.Element {
  const setTitle = useCanvasStore((s) => s.setTitle)
  const deleteChat = useCanvasStore((s) => s.deleteChat)
  const toggleMinimize = useCanvasStore((s) => s.toggleMinimize)
  const tapCtxKnob = useCanvasStore((s) => s.tapCtxKnob)
  const routeWidgetMessage = useCanvasStore((s) => s.routeWidgetMessage)
  const armed = useCanvasStore((s) => s.ctxConnectSource === id)

  const iframeRef = useRef<HTMLIFrameElement>(null)
  const titleRef = useRef<HTMLInputElement>(null)
  // Manual reload — remounts the frame (rev remounts it on update_widget).
  const [reloadTick, setReloadTick] = useState(0)

  const [editingTitle, setEditingTitle] = useState(false)
  if (data.minimized && editingTitle) setEditingTitle(false)
  const { duplicate, revert } = useTitleGuard(id, editingTitle, data.title)

  useEffect(() => {
    if (!editingTitle) return
    titleRef.current?.focus()
    titleRef.current?.select()
  }, [editingTitle])

  // The outbound half of the message bus: register this frame, and accept
  // window messages ONLY when their source is this widget's own contentWindow
  // (widgetIdForSource) — a page in some tab's webview can't spoof a widget.
  const frameKey = `${data.rev ?? 0}:${reloadTick}`
  useEffect(() => {
    const el = iframeRef.current
    if (!el) return
    registerWidgetFrame(id, el)
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
      if (widgetIdForSource(e.source) !== id) return
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
      // so momentum drifting out of the iframe keeps scrolling the widget.
      if (d.wheelUsed === true) {
        noteWidgetWheel(el, (dx, dy, mode) => {
          el.contentWindow?.postMessage(
            { __widgetIn: true, type: '__scroll', payload: { dx, dy, mode } },
            '*'
          )
        })
        return
      }
      // The user clicked inside the widget — select its node so wheel routing
      // (here and in the shim) treats it as the focused card.
      if (d.focused === true) {
        useCanvasStore.setState((s) => ({
          nodes: s.nodes.map((n) =>
            n.id === id
              ? n.selected
                ? n
                : { ...n, selected: true }
              : n.selected
                ? { ...n, selected: false }
                : n
          )
        }))
        return
      }
      // Wheel over an unfocused widget (or cmd/ctrl+wheel): the shim blocked
      // it inside the sandbox — replay it on the React Flow pane so the
      // canvas pans/zooms exactly as it would over any other card.
      const w = d.wheel as {
        dx?: unknown
        dy?: unknown
        mode?: unknown
        cx?: unknown
        cy?: unknown
        ctrl?: unknown
        meta?: unknown
      } | null
      if (w && typeof w.dx === 'number' && typeof w.dy === 'number') {
        const pane = el.closest('.react-flow')?.querySelector('.react-flow__pane')
        if (!pane) return
        // Iframe-local coordinates → screen: the rect is zoom-scaled, the
        // iframe's layout size isn't.
        const rect = el.getBoundingClientRect()
        const sx = el.clientWidth > 0 ? rect.width / el.clientWidth : 1
        const sy = el.clientHeight > 0 ? rect.height / el.clientHeight : 1
        pane.dispatchEvent(
          new WheelEvent('wheel', {
            deltaX: w.dx,
            deltaY: w.dy,
            deltaMode: typeof w.mode === 'number' ? w.mode : 0,
            clientX: rect.left + (typeof w.cx === 'number' ? w.cx : 0) * sx,
            clientY: rect.top + (typeof w.cy === 'number' ? w.cy : 0) * sy,
            ctrlKey: w.ctrl === true,
            metaKey: w.meta === true,
            bubbles: true,
            cancelable: true
          })
        )
        return
      }
      // canvas.fetch: broker the GET through main (which re-reads the
      // widget's net allowlist from disk) and post the result back in.
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
          .fetch(id, f.url)
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
      const msg = d.msg
      if (!msg || typeof msg !== 'object' || typeof (msg as { type?: unknown }).type !== 'string')
        return
      if (!allow(stamps, MSG_WINDOW_MS, MSG_WINDOW_MAX)) return
      routeWidgetMessage(id, msg as Record<string, unknown>)
    }
    window.addEventListener('message', onMessage)
    return () => {
      window.removeEventListener('message', onMessage)
      unregisterWidgetFrame(id, el)
    }
    // frameKey remounts the iframe element — re-register the fresh one.
  }, [id, routeWidgetMessage, frameKey])

  // Mirror the node's selection into the shim's focus gate: selecting the
  // card (clicking its header, or clicking inside — see d.focused above)
  // unlocks internal scrolling; deselecting locks wheel back to canvas pan.
  useEffect(() => {
    const el = iframeRef.current
    if (!el) return
    const post = (): void => {
      el.contentWindow?.postMessage({ __widgetIn: true, type: '__focus', payload: !!selected }, '*')
    }
    post()
    el.addEventListener('load', post)
    return () => el.removeEventListener('load', post)
  }, [selected, frameKey])

  const palette = paletteFor(data.color)

  return (
    <div
      style={
        {
          '--np-bg': palette.bg,
          '--np-edge': palette.edge,
          '--np-chip': `${palette.edge}99`,
          '--np-accent': palette.accent,
          '--np-deep': palette.deep,
          '--np-ring': `${palette.accent}B3`
        } as React.CSSProperties
      }
      className={`relative isolate flex h-full w-full flex-col rounded-[14px] border border-(--np-edge) shadow-md ${
        selected ? 'ring-2 ring-(--np-ring)' : ''
      }`}
    >
      <div
        aria-hidden
        className="absolute inset-0 rounded-[14px]"
        style={{ backgroundColor: PAPER, zIndex: -1 }}
      />
      {/* hidden layout anchors (left/right) for edges */}
      <Handle type="target" position={Position.Left} isConnectable={false} style={HIDDEN_HANDLE} />
      <Handle type="source" position={Position.Right} isConnectable={false} style={HIDDEN_HANDLE} />
      {/* the connection knob — square: a widget is a resource. Wiring it to a
          chat feeds the chat its HTML and lets prompt buttons send turns
          (a widget's only counterparty is a chat). */}
      <Handle
        id={CTX_HANDLE_ID}
        type="target"
        position={Position.Top}
        isConnectable
        isConnectableStart={false}
        style={ctxTargetStyle()}
      />
      <Handle
        id={OUTPUT_HANDLE_ID}
        type="source"
        position={Position.Top}
        isConnectable
        isConnectableEnd={false}
        title="Drag — or tap, then click a chat — to connect this widget"
        onClick={(e) => {
          e.stopPropagation()
          tapCtxKnob(id)
        }}
        className={`ctx-handle ${armed ? 'ctx-armed' : ''}`}
        style={ctxHandleStyle(palette.accent, 'top', 'square')}
      />

      {!data.minimized && (
        <>
          <NodeResizeControl
            position="right"
            variant={ResizeControlVariant.Line}
            {...RESIZE_LIMITS}
            style={{ borderColor: 'transparent', borderWidth: 5 }}
          />
          <NodeResizeControl
            position="bottom"
            variant={ResizeControlVariant.Line}
            {...RESIZE_LIMITS}
            style={{ borderColor: 'transparent', borderWidth: 5 }}
          />
          <NodeResizeControl
            position="bottom-right"
            {...RESIZE_LIMITS}
            style={{
              background: 'transparent',
              border: 'none',
              width: 16,
              height: 16,
              cursor: 'nwse-resize'
            }}
          />
        </>
      )}

      {/* colored header band, same chrome as the other cards */}
      <div
        style={{ backgroundColor: palette.bg }}
        className={`${DRAG_HEADER} flex shrink-0 items-center gap-2 px-3 py-1.5 ${
          data.minimized ? 'rounded-[13px]' : 'rounded-t-[13px] border-b border-(--np-edge)'
        }`}
      >
        <Tooltip label={data.minimized ? 'Expand' : 'Minimize'}>
          <button type="button" onClick={() => toggleMinimize(id)} className={CHIP_BUTTON}>
            {data.minimized ? (
              <Plus className="h-[25px] w-[25px]" />
            ) : (
              <Minus className="h-[25px] w-[25px]" />
            )}
          </button>
        </Tooltip>
        {editingTitle && !data.minimized ? (
          <input
            ref={titleRef}
            value={data.title}
            placeholder="Untitled widget"
            onChange={(e) => setTitle(id, e.target.value)}
            onBlur={() => {
              if (duplicate) revert()
              setEditingTitle(false)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                if (duplicate) return
                setEditingTitle(false)
              } else if (e.key === 'Escape') {
                e.preventDefault()
                if (duplicate) revert()
                setEditingTitle(false)
              }
            }}
            className="nodrag min-w-0 flex-1 cursor-text truncate bg-transparent text-[26px] font-medium text-(--np-deep) outline-none placeholder:text-(--np-deep) placeholder:opacity-50"
          />
        ) : (
          <span
            onDoubleClick={() => {
              if (!data.minimized) setEditingTitle(true)
            }}
            title={data.minimized ? undefined : 'Double-click to rename'}
            className={`min-w-0 flex-1 truncate text-[26px] font-medium text-(--np-deep) ${data.title ? '' : 'opacity-50'}`}
          >
            {data.title || 'Untitled widget'}
          </span>
        )}
        <div className="nodrag relative ml-auto flex shrink-0 items-center gap-1">
          {!data.minimized && (
            <TitleEditSlot
              editing={editingTitle}
              duplicate={duplicate}
              onEdit={() => setEditingTitle(true)}
              renameHint="Rename this widget"
            />
          )}
          {!data.minimized && (
            <Tooltip label="Reload this widget">
              <button
                type="button"
                onClick={() => setReloadTick((t) => t + 1)}
                className={CHIP_BUTTON}
              >
                <RotateCw className="h-[25px] w-[25px]" />
              </button>
            </Tooltip>
          )}
          <Tooltip label="Delete this widget">
            <button type="button" onClick={() => deleteChat(id, false)} className={CHIP_BUTTON}>
              <Trash2 className="h-[25px] w-[25px]" />
            </button>
          </Tooltip>
        </div>
      </div>

      {!data.minimized && (
        <div className="nodrag nowheel min-h-0 flex-1 cursor-auto overflow-hidden rounded-b-[13px]">
          <iframe
            key={frameKey}
            ref={iframeRef}
            src={`widget://${id}/?rev=${frameKey}`}
            sandbox="allow-scripts"
            title={data.title || 'Widget'}
            className="h-full w-full border-0"
            style={{ backgroundColor: PAPER }}
          />
        </div>
      )}
    </div>
  )
}

export default memo(WidgetNodeView)
