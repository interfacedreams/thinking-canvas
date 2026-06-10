import { memo, useEffect, useRef } from 'react'
import {
  NodeResizeControl,
  ResizeControlVariant,
  useReactFlow,
  type NodeProps
} from '@xyflow/react'
import TextareaAutosize from 'react-textarea-autosize'
import Markdown from 'react-markdown'
import { useCanvasStore, MAX_NODE_H, type ChatNode, type Message } from '../store/canvas'
import BeeIcon from './BeeIcon'

function MessageView({
  message,
  pending
}: {
  message: Message
  pending?: boolean
}): React.JSX.Element {
  if (message.role === 'user') {
    return (
      <div className="mb-2 ml-auto w-fit max-w-full rounded-[10px] bg-white px-3 py-2 break-words whitespace-pre-wrap">
        {message.text}
      </div>
    )
  }
  if (pending && !message.text) {
    return <div className="mb-2 animate-pulse px-3 py-1 tracking-widest text-neutral-400">●●●</div>
  }
  return (
    <div className="prose-chat mb-2 px-3 py-1">
      <Markdown>{message.text}</Markdown>
    </div>
  )
}

function MinimizeIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5">
      <path d="M3.5 8 H12.5" stroke="#92690B" strokeWidth={1.8} strokeLinecap="round" />
    </svg>
  )
}

function ExpandIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5">
      <g stroke="#92690B" strokeWidth={1.5} strokeLinecap="round" fill="none">
        <path d="M6.5 6.5 L2.5 2.5 M2.5 2.5 H5.5 M2.5 2.5 V5.5" />
        <path d="M9.5 6.5 L13.5 2.5 M13.5 2.5 H10.5 M13.5 2.5 V5.5" />
        <path d="M6.5 9.5 L2.5 13.5 M2.5 13.5 H5.5 M2.5 13.5 V10.5" />
        <path d="M9.5 9.5 L13.5 13.5 M13.5 13.5 H10.5 M13.5 13.5 V10.5" />
      </g>
    </svg>
  )
}

function ChatNodeView({ id, data, selected }: NodeProps<ChatNode>): React.JSX.Element {
  const setDraft = useCanvasStore((s) => s.setDraft)
  const send = useCanvasStore((s) => s.send)
  const discardNode = useCanvasStore((s) => s.discardNode)
  const toggleMinimize = useCanvasStore((s) => s.toggleMinimize)
  // Explicit height only (user resize / restored from disk) — React Flow's own
  // `height` prop reports the *measured* height, which would pin the node at
  // whatever size it currently is and stop it from growing with new content.
  const explicitHeight = useCanvasStore((s) => s.nodes.find((n) => n.id === id)?.height)
  const { fitView } = useReactFlow()

  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  // Follow new content only while the user is at (or near) the bottom,
  // so scrolling up to read history never gets yanked back down.
  const stickToBottom = useRef(true)
  const streaming = data.status === 'streaming'
  const empty = data.messages.length === 0

  // Refocus the composer the moment the assistant finishes in this node —
  // unless the user has moved on to typing somewhere else (don't steal focus).
  const wasStreaming = useRef(streaming)
  useEffect(() => {
    if (wasStreaming.current && !streaming) {
      const active = document.activeElement
      const typingElsewhere =
        active instanceof HTMLElement &&
        active !== textareaRef.current &&
        (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT' || active.isContentEditable)
      if (!typingElsewhere) textareaRef.current?.focus()
    }
    wasStreaming.current = streaming
  }, [streaming])

  // Arrive at the latest messages: jump to the bottom on mount.
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [])

  // The transcript is `nowheel` (plain scroll stays inside it), but two cases
  // must still reach React Flow: ⌘/ctrl+scroll and pinch (canvas zoom), and any
  // scroll the transcript can't absorb — no overflow, or already at the edge —
  // which pans the canvas so an off-screen node bottom can be scrolled into view.
  const lastInnerWheelAt = useRef(0)
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
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
    const onWheel = (e: WheelEvent): void => {
      if (e.metaKey || e.ctrlKey) {
        forwardToPane(e)
        return
      }
      // Any upward wheel during streaming releases the auto-follow immediately.
      if (e.deltaY < 0) stickToBottom.current = false
      // Mostly-horizontal gestures stay native (e.g. a code block scrolling sideways).
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return
      const canScroll = el.scrollHeight - el.clientHeight > 1
      const atEdge =
        e.deltaY < 0 ? el.scrollTop <= 0 : el.scrollHeight - el.scrollTop - el.clientHeight <= 1
      if (canScroll && !atEdge) {
        lastInnerWheelAt.current = performance.now()
        return
      }
      // At an edge, a fling that just landed here shouldn't slingshot into a
      // canvas pan — only chain once the gesture that hit the edge has died down.
      if (canScroll && performance.now() - lastInnerWheelAt.current < 200) return
      forwardToPane(e)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [empty])

  const handleScroll = (): void => {
    const el = scrollRef.current
    if (!el) return
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    if (distanceFromBottom < 8) stickToBottom.current = true
    else if (distanceFromBottom > 48) stickToBottom.current = false
  }
  useEffect(() => {
    const el = scrollRef.current
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight
  }, [data.messages])

  const canSend = !streaming && data.draft.trim().length > 0

  const expandAndCenter = (): void => {
    const fit = (): void => {
      void fitView({ nodes: [{ id }], duration: 300, padding: 0.1, maxZoom: 1 })
    }
    if (data.minimized) {
      toggleMinimize(id)
      // let React Flow re-measure the expanded node before fitting to it
      setTimeout(fit, 50)
    } else {
      fit()
    }
  }

  return (
    <div
      // the growth cap only limits auto-sizing; an explicit (user-resized) height wins
      style={{ maxHeight: explicitHeight ?? data.growthCap ?? MAX_NODE_H }}
      className={`drag-handle flex h-full w-full cursor-grab flex-col rounded-[14px] border border-black/5 bg-[#FEF3C7] shadow-md active:cursor-grabbing ${
        selected ? 'ring-2 ring-amber-400/70' : ''
      }`}
    >
      {!data.minimized && (
        <>
          <NodeResizeControl
            position="right"
            variant={ResizeControlVariant.Line}
            minWidth={360}
            minHeight={140}
            maxHeight={1280}
            style={{ borderColor: 'transparent', borderWidth: 5 }}
          />
          <NodeResizeControl
            position="bottom"
            variant={ResizeControlVariant.Line}
            minWidth={360}
            minHeight={140}
            maxHeight={1280}
            style={{ borderColor: 'transparent', borderWidth: 5 }}
          />
          <NodeResizeControl
            position="bottom-right"
            minWidth={360}
            minHeight={140}
            maxHeight={1280}
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

      <div
        className={`flex shrink-0 items-center gap-2 px-2 py-1 ${
          data.minimized ? '' : 'border-b border-[#EDD27E]'
        }`}
      >
        {!data.minimized && (
          <button
            type="button"
            onClick={() => toggleMinimize(id)}
            title="Minimize"
            className="nodrag flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded-md bg-[#EDD27E]/60 transition-colors hover:bg-[#E2BF52]"
          >
            <MinimizeIcon />
          </button>
        )}
        <button
          type="button"
          onClick={expandAndCenter}
          title={data.minimized ? 'Expand' : 'Zoom to fit'}
          className="nodrag flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded-md bg-[#EDD27E]/60 transition-colors hover:bg-[#E2BF52]"
        >
          <ExpandIcon />
        </button>
        <span
          className={`truncate text-[13px] font-medium ${data.title ? 'text-[#92690B]' : 'text-[#92690B]/50'}`}
        >
          {data.title || 'New chat'}
        </span>
      </div>

      {!data.minimized && empty && <div className="min-h-0 flex-1" />}

      {!data.minimized && !empty && (
        <div className="nodrag mx-1 mt-1 flex min-h-0 flex-1 cursor-auto flex-col overflow-hidden">
          <div
            ref={scrollRef}
            onScroll={handleScroll}
            className="nowheel select-text transcript-scroll min-h-0 flex-1 overflow-y-auto pb-1 text-[16px] leading-relaxed text-neutral-900"
          >
            {data.messages.map((m, i) => (
              <MessageView
                key={m.id}
                message={m}
                pending={streaming && i === data.messages.length - 1}
              />
            ))}
          </div>
        </div>
      )}

      {!data.minimized && (
        <div className="nodrag mx-1 mt-2 mb-1 shrink-0 cursor-auto rounded-[10px] bg-white text-[16px]">
          <TextareaAutosize
            ref={textareaRef}
            autoFocus={data.status === 'empty'}
            value={data.draft}
            minRows={1}
            placeholder={empty ? 'Ask anything…' : 'Reply…'}
            onChange={(e) => setDraft(id, e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                if (canSend) send(id)
              } else if (e.key === 'Escape' && empty && !data.draft) {
                discardNode(id)
              }
            }}
            className="block w-full resize-none bg-transparent px-3 py-2 outline-none placeholder:text-neutral-400"
          />
          <div className="flex items-center justify-end px-2 pb-1.5">
            <button
              type="button"
              onClick={() => send(id)}
              disabled={!canSend}
              title={streaming ? 'Waiting for the assistant to finish' : 'Send (Enter)'}
              className="transition-all hover:scale-110 active:scale-95 disabled:opacity-30"
            >
              <BeeIcon className="h-7 w-7" />
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

export default memo(ChatNodeView)
