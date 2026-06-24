import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import TextareaAutosize from 'react-textarea-autosize'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import 'katex/dist/katex.min.css'
import { RotateCcw, Telescope, TriangleAlert, Search, CheckCircle2, ArrowUp } from 'lucide-react'
import { useCanvasStore, isChat, type Message } from '../store/canvas'
import { useForwardedWheel } from '../lib/useForwardedWheel'
import { MarkdownSourceContext, markdownComponents } from '../lib/markdownLink'
import PermissionPrompt from './PermissionPrompt'

function MessageView({
  message,
  pending
}: {
  message: Message
  pending?: boolean
}): React.JSX.Element {
  if (message.role === 'user') {
    return (
      <div
        data-msg={message.id}
        className="mr-1 mb-2 ml-auto w-fit max-w-full rounded-[10px] bg-white/85 px-3 py-2 break-words whitespace-pre-wrap"
      >
        {message.text}
      </div>
    )
  }
  if (message.kind === 'research-spawn' || message.kind === 'research-done') {
    const done = message.kind === 'research-done'
    return (
      <div
        data-msg={message.id}
        className="mb-1 flex items-center gap-1.5 px-3 py-0.5 text-xs text-neutral-400"
      >
        {done ? (
          <CheckCircle2 size={11} className="shrink-0 text-neutral-400" />
        ) : (
          <Search size={11} className="shrink-0 animate-pulse" />
        )}
        <span className={done ? '' : 'animate-pulse'}>{message.text}</span>
      </div>
    )
  }
  if (pending && !message.text) {
    return (
      <div
        data-msg={message.id}
        className="mb-2 animate-pulse px-3 py-1 tracking-widest text-neutral-400"
      >
        ●●●
      </div>
    )
  }
  return (
    <div data-msg={message.id} className="prose-chat mb-2 px-3 py-1">
      <Markdown
        remarkPlugins={[remarkGfm, remarkBreaks, remarkMath]}
        rehypePlugins={[rehypeKatex]}
        components={markdownComponents}
      >
        {message.text}
      </Markdown>
      {pending && <div className="animate-pulse tracking-widest text-neutral-400">●●●</div>}
    </div>
  )
}

export interface ChatBodyHandle {
  focusComposer: () => void
}

/**
 * A chat's living parts — transcript, error banner, permission prompt,
 * composer — driven by the node id straight from the store, so the same
 * component serves the canvas card and the side panel (only one renders at a
 * time: the card shows a stub while the chat is docked). Expects to be laid
 * out inside a flex column that carries the node's palette CSS variables.
 *
 * `focused` gates wheel routing on the canvas (an unfocused card pans the
 * board); the panel passes inPanel, which scrolls natively instead.
 */
const ChatBody = forwardRef<
  ChatBodyHandle,
  { id: string; focused: boolean; inPanel?: boolean; onScrolled?: () => void }
>(function ChatBody({ id, focused, inPanel = false, onScrolled }, ref) {
  const node = useCanvasStore((s) => s.nodes.find((n) => n.id === id))
  const setDraft = useCanvasStore((s) => s.setDraft)
  const send = useCanvasStore((s) => s.send)
  const retry = useCanvasStore((s) => s.retry)
  const respondPermission = useCanvasStore((s) => s.respondPermission)
  const toggleResearch = useCanvasStore((s) => s.toggleResearch)
  const discardNode = useCanvasStore((s) => s.discardNode)
  const clearFocusDraft = useCanvasStore((s) => s.clearFocusDraft)

  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  useImperativeHandle(ref, () => ({ focusComposer: () => textareaRef.current?.focus() }), [])

  const data = node && isChat(node) ? node.data : undefined
  const streaming = data?.status === 'streaming'
  const empty = !data || data.messages.length === 0
  const isResearch = data?.kind === 'research'
  const focusDraft = data?.focusDraft === true

  // Refocus the composer the moment the assistant finishes in this chat —
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

  // Spawned via ⌘N / double-click / fork: pull the keyboard into this composer,
  // even if another chat's composer currently has focus. A fresh node mounts
  // `visibility: hidden` until React Flow measures it, and focus() on a hidden
  // element is silently ignored — so retry every frame until focus sticks, and
  // only then consume the focusDraft flag.
  useEffect(() => {
    if (!focusDraft) return
    let raf = 0
    const tryFocus = (): void => {
      const el = textareaRef.current
      if (!el) return
      el.focus()
      if (document.activeElement === el) clearFocusDraft(id)
      else raf = requestAnimationFrame(tryFocus)
    }
    tryFocus()
    return () => cancelAnimationFrame(raf)
  }, [focusDraft, clearFocusDraft, id])

  // Arrive at the latest messages: jump to the bottom on mount.
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [])

  // Scrolling the transcript requires focus (the node is selected by clicking
  // it); otherwise the wheel pans the canvas. The panel is outside the
  // canvas — it scrolls natively, no routing.
  useForwardedWheel(scrollRef, !inPanel && !empty, focused)

  const handleScroll = (): void => {
    onScrolled?.() // canvas cards re-measure fork-edge anchors
  }

  if (!data) return null
  const canSend = !streaming && data.draft.trim().length > 0

  return (
    <MarkdownSourceContext.Provider value={id}>
      {/* empty transcript area sized so a fresh chat matches a fresh note
          (header + 172px reserved note body) */}
      {empty && <div className="min-h-[98px] flex-1" />}

      {!empty && (
        <div className="nodrag mx-1 mt-3 flex min-h-0 flex-1 cursor-auto flex-col overflow-hidden">
          <div
            ref={scrollRef}
            onScroll={handleScroll}
            className="nowheel select-text transcript-scroll min-h-0 flex-1 overflow-x-hidden overflow-y-auto pb-1 text-[16px] leading-relaxed text-neutral-900"
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

      {data.status === 'error' && (
        <div className="nodrag mx-1 mt-2 flex shrink-0 cursor-auto items-start gap-2 rounded-[10px] bg-red-50/90 px-3 py-2 text-[14px] leading-snug text-red-800">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
          <span className="min-w-0 flex-1 break-words select-text">
            {data.lastError ?? 'The turn failed.'}
          </span>
          <button
            type="button"
            onClick={() => retry(id)}
            title="Retry the failed message"
            className="flex shrink-0 items-center gap-1 rounded-md bg-red-700 px-2.5 py-1 font-medium text-white transition-colors hover:bg-red-800"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            Retry
          </button>
        </div>
      )}

      {data.pendingPermission && (
        <PermissionPrompt
          request={data.pendingPermission}
          onRespond={(allow) => respondPermission(id, data.pendingPermission!.requestId, allow)}
        />
      )}

      {!isResearch && (
        <div
          className={`nodrag mx-1 mt-2 shrink-0 cursor-auto rounded-[10px] bg-white/85 text-[16px] ${
            // the panel runs to the window's bottom edge — give the composer
            // real clearance from it
            inPanel ? 'mb-2' : 'mb-1'
          }`}
        >
          <TextareaAutosize
            ref={textareaRef}
            autoFocus={data.status === 'empty' || data.focusDraft === true}
            value={data.draft}
            minRows={1}
            placeholder={empty ? 'Ask anything…' : 'Reply…'}
            onChange={(e) => setDraft(id, e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                if (canSend) send(id)
              } else if (e.key === 'Escape') {
                if (empty && !data.draft) discardNode(id)
                else e.currentTarget.blur()
              }
            }}
            className="block w-full resize-none bg-transparent px-3 py-2 outline-none placeholder:text-neutral-400"
          />
          <div className="flex items-center justify-between px-2 pb-1.5">
            <button
              type="button"
              onClick={() => toggleResearch(id)}
              title="Research mode: spawn parallel web researchers for this message"
              className={`rounded-md p-1 transition-colors ${
                data.researchArmed
                  ? 'bg-(--np-accent) text-white'
                  : 'text-neutral-400 hover:text-neutral-600'
              }`}
            >
              <Telescope className="h-5 w-5" />
            </button>
            <button
              type="button"
              onClick={() => send(id)}
              disabled={!canSend}
              title={streaming ? 'Waiting for the assistant to finish' : 'Send (Enter)'}
              className="flex h-7 w-7 items-center justify-center rounded-full bg-(--np-accent) text-white transition-all hover:scale-110 active:scale-95 disabled:opacity-30"
            >
              <ArrowUp className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}
    </MarkdownSourceContext.Provider>
  )
})

export default ChatBody
