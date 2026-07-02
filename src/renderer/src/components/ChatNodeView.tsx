import { memo, useCallback, useEffect, useRef, useState } from 'react'
import {
  Handle,
  NodeResizeControl,
  Position,
  ResizeControlVariant,
  useStoreApi,
  type NodeProps
} from '@xyflow/react'
import { Brain, Minus, Plus, Trash2, TriangleAlert } from 'lucide-react'
import { useCanvasStore, MAX_NODE_H, type ChatNode } from '../store/canvas'
import { paletteFor } from '../lib/palette'
import { usePanel } from '../lib/usePanel'
import ChatBody, { type ChatBodyHandle } from './ChatBody'
import DockedStub from './DockedStub'
import PanelChips from './PanelChips'
import TransformButton from './TransformButton'
import TransformFrame from './TransformFrame'
import Tooltip from './Tooltip'
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

function ChatNodeView({ id, data, selected, height }: NodeProps<ChatNode>): React.JSX.Element {
  const setTitle = useCanvasStore((s) => s.setTitle)
  const deleteChat = useCanvasStore((s) => s.deleteChat)
  const togglePin = useCanvasStore((s) => s.togglePin)
  const toggleMinimize = useCanvasStore((s) => s.toggleMinimize)
  const setCtxConnectSource = useCanvasStore((s) => s.setCtxConnectSource)
  const armed = useCanvasStore((s) => s.ctxConnectSource === id)
  // While the transform composer is open, its tab covers the node's top; hide
  // the top connector so its circle doesn't poke out over the tab seam.
  const transforming = useCanvasStore((s) => s.transforming === id)
  // Explicit height only (user resize / restored from disk) — React Flow's own
  // `height` prop reports the *measured* height, which would pin the node at
  // whatever size it currently is and stop it from growing with new content.
  const explicitHeight = useCanvasStore((s) => s.nodes.find((n) => n.id === id)?.height)
  const { docked, mode, open, collapse } = usePanel(id)

  // Hold the chat's height while it's docked so its card box stays put when the
  // conversation pops into the side panel (the stub centers in it). An
  // auto-sized chat has no stored height, so we freeze the last measured one; a
  // user-resized chat already keeps its explicit height and needs no help.
  const lastMeasured = useRef<number | undefined>(undefined)
  if (!docked && height != null) lastMeasured.current = height
  const dockHold = docked && explicitHeight == null ? lastMeasured.current : undefined

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

  return (
    <div
      ref={rootRef}
      style={
        {
          // the growth cap only limits auto-sizing; an explicit (user-resized) height wins
          maxHeight: explicitHeight ?? data.growthCap ?? MAX_NODE_H,
          minHeight: dockHold,
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
      {/* Opaque card fill. Sits above the transform wrapper's background (which
          rides a deeper negative z) but below all card content, so the wrapper's
          colored tab can never bleed through the card's top edge. As a child it
          paints above the root's own background layer, which a plain
          `backgroundColor` would not — the chat header is transparent, so the
          fill has to win over the tab here. */}
      <div
        aria-hidden
        className="absolute inset-0 rounded-[14px]"
        style={{ backgroundColor: palette.bg, zIndex: -1 }}
      />
      {/* invisible anchors so fork edges have somewhere to attach */}
      <Handle type="target" position={Position.Left} isConnectable={false} style={HIDDEN_HANDLE} />
      <Handle type="source" position={Position.Right} isConnectable={false} style={HIDDEN_HANDLE} />
      {/* the context connector: notes' and images' circles drop here.
          Receive-only — a context arrow always starts at a note or image.
          Research transcripts can't send, so context would never reach a
          model; they get no circle. */}
      {!isResearch && !transforming && (
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
      {/* the output connector, doing double duty. Tap it (or drag), then: click
          a note to let this chat read AND write it, or click empty canvas to
          fork the chat there. On the right so the chat's output reads
          left-to-right (context still comes in from the top). Research chats
          can't edit or fork meaningfully, so they get no output port. */}
      {!isResearch && (
        <Handle
          id={OUTPUT_HANDLE_ID}
          type="source"
          position={Position.Right}
          isConnectable
          isConnectableEnd={false}
          title="Tap to add a chat"
          onClick={(e) => {
            e.stopPropagation()
            setCtxConnectSource(armed ? null : id)
          }}
          className={`ctx-handle ${armed ? 'ctx-armed' : ''}`}
          style={ctxHandleStyle(palette.accent, 'right', 'circle')}
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
        <Tooltip label={data.minimized ? 'Expand' : 'Minimize'}>
          <button type="button" onClick={() => toggleMinimize(id)} className={CHIP_BUTTON}>
            {data.minimized ? (
              <Plus className="h-[25px] w-[25px]" />
            ) : (
              <Minus className="h-[25px] w-[25px]" />
            )}
          </button>
        </Tooltip>
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
            className={`min-w-0 flex-1 truncate text-[23px] font-medium ${
              awaitingTitle
                ? 'animate-pulse tracking-widest text-neutral-400'
                : `text-(--np-deep) ${data.title ? '' : 'opacity-50'}`
            }`}
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
          {!data.minimized && <TransformButton id={id} />}
          {!data.minimized && !isResearch && (
            <Tooltip
              label={
                data.pinned
                  ? 'In project memory — every new chat sees this chat'
                  : 'Add to project memory'
              }
            >
              <button
                type="button"
                onClick={() => togglePin(id)}
                className={`nodrag flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-lg transition-colors ${
                  data.pinned
                    ? 'bg-(--np-accent) text-white'
                    : 'bg-(--np-chip) text-(--np-deep) hover:bg-(--np-accent)'
                }`}
              >
                <Brain className="h-[25px] w-[25px]" />
              </button>
            </Tooltip>
          )}
          <Tooltip label="Delete this chat">
            <button type="button" onClick={() => deleteChat(id, false)} className={CHIP_BUTTON}>
              <Trash2 className="h-[25px] w-[25px]" />
            </button>
          </Tooltip>
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
