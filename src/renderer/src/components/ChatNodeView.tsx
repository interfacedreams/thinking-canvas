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
import { GitFork, Minus, Trash2, TriangleAlert } from 'lucide-react'
import { useCanvasStore, MAX_NODE_H, type ChatNode } from '../store/canvas'
import { paletteFor } from '../lib/palette'
import { usePanel } from '../lib/usePanel'
import ChatBody, { type ChatBodyHandle } from './ChatBody'
import DockedStub from './DockedStub'
import PanelChips from './PanelChips'
import TransformButton from './TransformButton'
import TransformFrame from './TransformFrame'
import {
  CHIP_BUTTON,
  CTX_HANDLE_ID,
  ctxHandleStyle,
  DRAG_HEADER,
  HIDDEN_HANDLE,
  OUTPUT_HANDLE_ID
} from '../lib/nodeChrome'
import { useTitleGuard } from '../lib/titleGuard'
import TitleEditSlot from './TitleEditSlot'

function ChatNodeView({ id, data, selected }: NodeProps<ChatNode>): React.JSX.Element {
  const setTitle = useCanvasStore((s) => s.setTitle)
  const forkChat = useCanvasStore((s) => s.forkChat)
  const requestDelete = useCanvasStore((s) => s.requestDelete)
  const toggleMinimize = useCanvasStore((s) => s.toggleMinimize)
  const setCtxConnectSource = useCanvasStore((s) => s.setCtxConnectSource)
  const armed = useCanvasStore((s) => s.ctxConnectSource === id)
  // Explicit height only (user resize / restored from disk) — React Flow's own
  // `height` prop reports the *measured* height, which would pin the node at
  // whatever size it currently is and stop it from growing with new content.
  const explicitHeight = useCanvasStore((s) => s.nodes.find((n) => n.id === id)?.height)
  const { fitView } = useReactFlow()
  const { docked, mode, open, collapse } = usePanel(id)

  const titleRef = useRef<HTMLInputElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<ChatBodyHandle>(null)

  // The title is static text (part of the header drag surface) until the user
  // enters rename mode via the pencil button or a double-click on the title.
  // Minimizing exits rename during render because the input unmounts blur-less.
  const [editingTitle, setEditingTitle] = useState(false)
  if (data.minimized && editingTitle) setEditingTitle(false)
  // Renaming to a title another node already wears is refused: warn, block the
  // save, and snap back to the original name if the user leaves it colliding.
  const { duplicate, revert } = useTitleGuard(id, editingTitle, data.title)

  useEffect(() => {
    if (!editingTitle) return
    titleRef.current?.focus()
    titleRef.current?.select()
  }, [editingTitle])

  const streaming = data.status === 'streaming'
  // Unnamed once the chat is underway: show a pulsing "…" until the background
  // title turn lands (see the thread-event handler) instead of the raw prompt.
  const awaitingTitle = !data.title && data.messages.length > 0
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
      .flatMap((e) => (e.source === id && e.sourceMessageId ? [e.sourceMessageId] : []))
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
  // and go — setAnchorOffsets no-ops when nothing moved. (While the chat is
  // docked, its messages aren't on the canvas — anchors degrade to the node
  // edge, which is where the stub sits anyway.)
  useEffect(measureAnchors)

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
          backgroundColor: palette.bg, // body fill, fully opaque
          '--np-bg': palette.bg,
          '--np-edge': palette.edge,
          '--np-chip': `${palette.edge}99`, // chip buttons at 60%
          '--np-accent': palette.accent,
          '--np-deep': palette.deep,
          '--np-ring': `${palette.accent}B3` // selection ring at 70%
        } as React.CSSProperties
      }
      className={`relative isolate flex h-full w-full flex-col rounded-[14px] border border-black/5 shadow-md ${
        selected ? 'ring-2 ring-(--np-ring)' : ''
      }`}
    >
      <TransformFrame id={id} />
      {/* invisible anchors so fork edges have somewhere to attach */}
      <Handle type="target" position={Position.Left} isConnectable={false} style={HIDDEN_HANDLE} />
      <Handle type="source" position={Position.Right} isConnectable={false} style={HIDDEN_HANDLE} />
      {/* the context connector: notes' and images' circles drop here.
          Receive-only — a context arrow always starts at a note or image.
          Research transcripts can't send, so context would never reach a
          model; they get no circle. */}
      {!isResearch && (
        <Handle
          id={CTX_HANDLE_ID}
          type="target"
          position={Position.Top}
          isConnectable
          isConnectableStart={false}
          title="Drop a note's or image's circle here to attach it as context"
          className="ctx-handle"
          style={ctxHandleStyle(palette.accent)}
        />
      )}
      {/* the output connector: drag this circle onto a note's top square — or
          tap it, then click a note — to let this chat read AND write that note.
          Research chats can't edit, so they get no output port. */}
      {!isResearch && (
        <Handle
          id={OUTPUT_HANDLE_ID}
          type="source"
          position={Position.Bottom}
          isConnectable
          isConnectableEnd={false}
          title="Drag — or tap, then click a note — to let this chat write that note"
          onClick={(e) => {
            e.stopPropagation()
            setCtxConnectSource(armed ? null : id)
          }}
          className={`ctx-handle ${armed ? 'ctx-armed' : ''}`}
          style={ctxHandleStyle(palette.accent, 'bottom', 'circle')}
        />
      )}

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
        <PanelChips mode={mode} open={open} />
        {editingTitle && !data.minimized ? (
          <input
            ref={titleRef}
            value={data.title}
            placeholder="New chat"
            onChange={(e) => setTitle(id, e.target.value)}
            onBlur={() => {
              if (duplicate) revert()
              setEditingTitle(false)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                if (duplicate) return // a colliding title can't be committed
                setEditingTitle(false)
                bodyRef.current?.focusComposer()
              } else if (e.key === 'Escape') {
                if (duplicate) revert()
                setEditingTitle(false)
              }
            }}
            className="nodrag min-w-0 flex-1 cursor-text truncate bg-transparent text-[23px] font-medium text-(--np-deep) outline-none placeholder:text-(--np-deep) placeholder:opacity-50"
          />
        ) : (
          <span
            onDoubleClick={() => {
              if (!data.minimized) setEditingTitle(true)
            }}
            title={data.minimized ? undefined : 'Double-click to rename'}
            className={`min-w-0 flex-1 truncate text-[23px] font-medium text-(--np-deep) ${data.title ? '' : 'opacity-50'} ${awaitingTitle ? 'animate-pulse tracking-widest' : ''}`}
          >
            {awaitingTitle ? '●●●' : data.title || 'New chat'}
          </span>
        )}
        {data.minimized && streaming && (
          <span className="shrink-0 animate-pulse tracking-widest text-neutral-400">●●●</span>
        )}
        {data.minimized && data.status === 'error' && (
          <TriangleAlert
            className="h-5 w-5 shrink-0 text-red-600"
            aria-label={data.lastError ?? 'The turn failed'}
          />
        )}
        <div className="nodrag relative ml-auto flex shrink-0 items-center gap-1">
          {!data.minimized && (
            <TitleEditSlot
              editing={editingTitle}
              duplicate={duplicate}
              onEdit={() => setEditingTitle(true)}
              renameHint="Rename this chat"
            />
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
          {!data.minimized && <TransformButton id={id} />}
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

      {!data.minimized &&
        (docked ? (
          <DockedStub onClick={collapse} />
        ) : (
          <ChatBody ref={bodyRef} id={id} focused={!!selected} onScrolled={measureAnchors} />
        ))}
    </div>
  )
}

export default memo(ChatNodeView)
