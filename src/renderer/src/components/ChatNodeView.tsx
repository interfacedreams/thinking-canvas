import { memo, useCallback, useEffect, useRef, useState } from 'react'
import {
  Handle,
  NodeResizeControl,
  Position,
  ResizeControlVariant,
  useReactFlow,
  useStoreApi,
  type NodeProps
} from '@xyflow/react'
import TextareaAutosize from 'react-textarea-autosize'
import Markdown from 'react-markdown'
import { Expand, GitFork, Minus, Pencil, Telescope, Trash2 } from 'lucide-react'
import { useCanvasStore, MAX_NODE_H, type ChatNode, type Message } from '../store/canvas'
import { paletteFor } from '../lib/palette'
import { useForwardedWheel } from '../lib/useForwardedWheel'
import { CHIP_BUTTON, DRAG_HEADER, HIDDEN_HANDLE } from '../lib/nodeChrome'
import BeeIcon from './BeeIcon'
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
      <Markdown>{message.text}</Markdown>
      {pending && (
        <div className="animate-pulse tracking-widest text-neutral-400">●●●</div>
      )}
    </div>
  )
}

function ChatNodeView({ id, data, selected }: NodeProps<ChatNode>): React.JSX.Element {
  const setDraft = useCanvasStore((s) => s.setDraft)
  const setTitle = useCanvasStore((s) => s.setTitle)
  const send = useCanvasStore((s) => s.send)
  const respondPermission = useCanvasStore((s) => s.respondPermission)
  const forkChat = useCanvasStore((s) => s.forkChat)
  const toggleResearch = useCanvasStore((s) => s.toggleResearch)
  const requestDelete = useCanvasStore((s) => s.requestDelete)
  const discardNode = useCanvasStore((s) => s.discardNode)
  const toggleMinimize = useCanvasStore((s) => s.toggleMinimize)
  const clearFocusDraft = useCanvasStore((s) => s.clearFocusDraft)
  // Explicit height only (user resize / restored from disk) — React Flow's own
  // `height` prop reports the *measured* height, which would pin the node at
  // whatever size it currently is and stop it from growing with new content.
  const explicitHeight = useCanvasStore((s) => s.nodes.find((n) => n.id === id)?.height)
  const { fitView } = useReactFlow()

  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const titleRef = useRef<HTMLInputElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  // The title is static text (part of the header drag surface) until the user
  // enters rename mode via the pencil button or a double-click on the title.
  // Minimizing exits rename during render because the input unmounts blur-less.
  const [editingTitle, setEditingTitle] = useState(false)
  if (data.minimized && editingTitle) setEditingTitle(false)

  useEffect(() => {
    if (!editingTitle) return
    titleRef.current?.focus()
    titleRef.current?.select()
  }, [editingTitle])
  // Follow new content only while the user is at (or near) the bottom,
  // so scrolling up to read history never gets yanked back down.
  const stickToBottom = useRef(true)
  const streaming = data.status === 'streaming'
  const empty = data.messages.length === 0
  // Researcher transcripts spawned by a research turn — display-only: they ran
  // inside the lead's session, so there's nothing to reply to (and no composer).
  const isResearch = data.kind === 'research'
  // Fork-ahead: forkable once the chat has a tip (a completed assistant reply).
  // Forks qualify too once their first turn lands — sessions chain freely.
  const canFork = !streaming && data.messages.some((m) => m.role === 'assistant' && m.uuid)

  const palette = paletteFor(data.color)

  // Fork edges attach to their anchor message, so measure where those messages
  // sit inside this node (flow px from the node top, clamped into the node so a
  // scrolled-away anchor degrades to the node edge instead of floating outside).
  const flowStore = useStoreApi()
  const setAnchorOffsets = useCanvasStore((s) => s.setAnchorOffsets)
  const anchorKey = useCanvasStore((s) =>
    s.edges
      .filter((e) => e.source === id)
      .map((e) => e.sourceMessageId)
      .join(',')
  )
  const measureAnchors = useCallback(() => {
    const root = rootRef.current
    if (!root) return
    const offsets: Record<string, number> = {}
    if (anchorKey) {
      const zoom = flowStore.getState().transform[2]
      const rootRect = root.getBoundingClientRect()
      const headerH = 56 // keep endpoints below the title row
      const maxY = Math.max(headerH, rootRect.height / zoom - 12)
      for (const messageId of anchorKey.split(',')) {
        const el = root.querySelector(`[data-msg="${messageId}"]`)
        if (!el) continue
        const r = el.getBoundingClientRect()
        const center = (r.top + r.height / 2 - rootRect.top) / zoom
        offsets[messageId] = Math.min(Math.max(center, headerH), maxY)
      }
    }
    setAnchorOffsets(id, offsets)
  }, [anchorKey, flowStore, id, setAnchorOffsets])
  // Re-measure after every commit: messages stream in, nodes resize, forks come
  // and go — setAnchorOffsets no-ops when nothing moved.
  useEffect(measureAnchors)

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

  // Spawned via ⌘N / double-click / fork: pull the keyboard into this composer,
  // even if another chat's composer currently has focus. A fresh node mounts
  // `visibility: hidden` until React Flow measures it, and focus() on a hidden
  // element is silently ignored — so retry every frame until focus sticks, and
  // only then consume the focusDraft flag.
  useEffect(() => {
    if (!data.focusDraft) return
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
  }, [data.focusDraft, clearFocusDraft, id])

  // Arrive at the latest messages: jump to the bottom on mount.
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [])

  // Scrolling the transcript requires focus (the node is selected by clicking
  // it); otherwise the wheel pans the canvas. Any upward wheel during
  // streaming releases the auto-follow immediately.
  useForwardedWheel(scrollRef, !empty && !data.minimized, !!selected, () => {
    stickToBottom.current = false
  })

  const handleScroll = (): void => {
    const el = scrollRef.current
    if (!el) return
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    if (distanceFromBottom < 8) stickToBottom.current = true
    else if (distanceFromBottom > 48) stickToBottom.current = false
    measureAnchors() // anchor messages move with the transcript
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

  const forkAndCenter = (): void => {
    const forkId = forkChat(id)
    if (!forkId) return
    // let React Flow mount and measure the new node before fitting to it
    setTimeout(() => {
      void fitView({ nodes: [{ id: forkId }], duration: 300, padding: 0.1, maxZoom: 1 })
    }, 50)
  }

  return (
    <div
      ref={rootRef}
      style={
        {
          // the growth cap only limits auto-sizing; an explicit (user-resized) height wins
          maxHeight: explicitHeight ?? data.growthCap ?? MAX_NODE_H,
          backgroundColor: `${palette.bg}D9`, // body fill at 85%
          '--np-bg': palette.bg,
          '--np-edge': palette.edge,
          '--np-chip': `${palette.edge}99`, // chip buttons at 60%
          '--np-accent': palette.accent,
          '--np-deep': palette.deep,
          '--np-ring': `${palette.accent}B3` // selection ring at 70%
        } as React.CSSProperties
      }
      className={`flex h-full w-full flex-col rounded-[14px] border border-black/5 shadow-md ${
        selected ? 'ring-2 ring-(--np-ring)' : ''
      }`}
    >
      {/* invisible anchors so fork edges have somewhere to attach */}
      <Handle type="target" position={Position.Left} isConnectable={false} style={HIDDEN_HANDLE} />
      <Handle type="source" position={Position.Right} isConnectable={false} style={HIDDEN_HANDLE} />

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
        className={`${DRAG_HEADER} flex shrink-0 items-center gap-2 px-3 py-1.5 ${
          data.minimized ? '' : 'border-b border-(--np-edge)'
        }`}
      >
        {!data.minimized && (
          <button
            type="button"
            onClick={() => toggleMinimize(id)}
            title="Minimize"
            className={CHIP_BUTTON}
          >
            <Minus className="h-[25px] w-[25px]" />
          </button>
        )}
        <button
          type="button"
          onClick={expandAndCenter}
          title={data.minimized ? 'Expand' : 'Zoom to fit'}
          className={CHIP_BUTTON}
        >
          <Expand className="h-[25px] w-[25px]" />
        </button>
        {editingTitle && !data.minimized ? (
          <input
            ref={titleRef}
            value={data.title}
            placeholder="New chat"
            onChange={(e) => setTitle(id, e.target.value)}
            onBlur={() => setEditingTitle(false)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                setEditingTitle(false)
                textareaRef.current?.focus()
              } else if (e.key === 'Escape') {
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
            {data.title || 'New chat'}
          </span>
        )}
        {data.minimized && streaming && (
          <span className="shrink-0 animate-pulse tracking-widest text-neutral-400">●●●</span>
        )}
        <div className="nodrag relative ml-auto flex shrink-0 items-center gap-1">
          {!data.minimized && (
            <button
              type="button"
              onClick={() => setEditingTitle(true)}
              title="Rename this chat"
              className={CHIP_BUTTON}
            >
              <Pencil className="h-[25px] w-[25px]" />
            </button>
          )}
          {canFork && (
            <button
              type="button"
              onClick={forkAndCenter}
              title="Fork this chat from its latest message"
              className={CHIP_BUTTON}
            >
              <GitFork className="h-[25px] w-[25px]" />
            </button>
          )}
          <button
            type="button"
            onClick={() => requestDelete(id)}
            title="Delete this chat"
            className={CHIP_BUTTON}
          >
            <Trash2 className="h-[25px] w-[25px]" />
          </button>
        </div>
      </div>

      {/* empty transcript area sized so a fresh chat matches a fresh note
          (header + 172px reserved note body) */}
      {!data.minimized && empty && <div className="min-h-[98px] flex-1" />}

      {!data.minimized && !empty && (
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

      {!data.minimized && data.pendingPermission && (
        <PermissionPrompt
          request={data.pendingPermission}
          onRespond={(allow) => respondPermission(id, data.pendingPermission!.requestId, allow)}
        />
      )}

      {!data.minimized && !isResearch && (
        <div className="nodrag mx-1 mt-2 mb-1 shrink-0 cursor-auto rounded-[10px] bg-white/85 text-[16px]">
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
