import { memo, useEffect, useRef, useState } from 'react'
import {
  Handle,
  NodeResizeControl,
  Position,
  ResizeControlVariant,
  type NodeProps
} from '@xyflow/react'
import { ChevronLeft, ChevronRight, Minus, Trash2 } from 'lucide-react'
import { useCanvasStore, MAX_NODE_H, notePager, type NoteNode } from '../store/canvas'
import { paletteFor } from '../lib/palette'
import { usePanel } from '../lib/usePanel'
import NoteBody from './NoteBody'
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
  INPUT_HANDLE_ID
} from '../lib/nodeChrome'
import { useTitleGuard } from '../lib/titleGuard'
import TitleEditSlot from './TitleEditSlot'
import { type NoteEditorHandle } from './NoteEditor'

// Notes read as paper, not post-it: a warm-white ruled body under a colored
// header band (chats are solid colored cards).
const PAPER = '#FFFDF6'

function NoteNodeView({ id, data, selected }: NodeProps<NoteNode>): React.JSX.Element {
  const setTitle = useCanvasStore((s) => s.setTitle)
  const commitNoteTitle = useCanvasStore((s) => s.commitNoteTitle)
  const requestDelete = useCanvasStore((s) => s.requestDelete)
  const discardNode = useCanvasStore((s) => s.discardNode)
  const toggleMinimize = useCanvasStore((s) => s.toggleMinimize)
  const clearFocusDraft = useCanvasStore((s) => s.clearFocusDraft)
  const setCtxConnectSource = useCanvasStore((s) => s.setCtxConnectSource)
  const setViewVersion = useCanvasStore((s) => s.setViewVersion)
  const armed = useCanvasStore((s) => s.ctxConnectSource === id)
  const explicitHeight = useCanvasStore((s) => s.nodes.find((n) => n.id === id)?.height)
  const { docked, mode, open, collapse } = usePanel(id)

  // Version pager: a floating ‹ n/total › control below the note. Positions
  // run 1..total with the last always the live, editable content; stepping
  // back parks the body on a read-only snapshot (NoteBody renders it).
  const { position, total } = notePager(data)
  const goTo = (p: number): void => {
    const clamped = Math.min(Math.max(p, 1), total)
    setViewVersion(id, clamped >= total ? undefined : clamped - 1)
  }

  const titleRef = useRef<HTMLInputElement>(null)
  const editorRef = useRef<NoteEditorHandle>(null)

  const streaming = data.status === 'streaming'
  // Unnamed but already streaming or filled in: show a pulsing "…" until the
  // background title turn lands (see the thread-event handler).
  const awaitingTitle = !data.title && (streaming || !!data.content)
  const palette = paletteFor(data.color)

  // A note is discardable while it has no substance yet.
  const blank = !data.content && !data.title && !data.sessionId

  // The title is static text (part of the header drag surface) until the user
  // enters rename mode via the pencil button or a double-click on the title.
  // State adjustments happen during render (not effects): a fresh note
  // (button / ⇧⌘N / alt+double-click) opens in rename mode so it can be named
  // first, and minimizing exits rename because the input unmounts blur-less.
  const [editingTitle, setEditingTitle] = useState(false)
  if (data.minimized && editingTitle) setEditingTitle(false)
  else if (data.focusDraft && !editingTitle) setEditingTitle(true)
  // Renaming to a title another node already wears is refused: warn, block the
  // save, and snap back to the original name if the user leaves it colliding.
  const { duplicate, revert } = useTitleGuard(id, editingTitle, data.title)

  // Focus the title input when rename mode opens. A fresh node mounts
  // `visibility: hidden` until React Flow measures it, and focus() on a hidden
  // element is silently ignored — retry every frame until focus sticks, then
  // consume the focusDraft flag.
  useEffect(() => {
    if (!editingTitle) return
    let raf = 0
    const tryFocus = (): void => {
      const el = titleRef.current
      if (!el) return
      el.focus()
      if (document.activeElement === el) {
        el.select()
        if (useCanvasStore.getState().nodes.some((n) => n.id === id && n.data.focusDraft)) {
          clearFocusDraft(id)
        }
      } else {
        raf = requestAnimationFrame(tryFocus)
      }
    }
    tryFocus()
    return () => cancelAnimationFrame(raf)
  }, [editingTitle, clearFocusDraft, id])

  return (
    <div
      style={
        {
          maxHeight: explicitHeight ?? data.growthCap ?? MAX_NODE_H,
          backgroundColor: PAPER, // paper fill, fully opaque
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
      <TransformFrame id={id} />
      {/* hidden layout anchors (left/right) kept for any id-less edges */}
      <Handle type="target" position={Position.Left} isConnectable={false} style={HIDDEN_HANDLE} />
      <Handle type="source" position={Position.Right} isConnectable={false} style={HIDDEN_HANDLE} />
      {/* the input connector: a chat's bottom circle drops here to gain
          read+write access to this note. Receive-only — the arrow always
          starts at the chat. */}
      <Handle
        id={INPUT_HANDLE_ID}
        type="target"
        position={Position.Top}
        isConnectable
        isConnectableStart={false}
        title="Drop a chat's circle here to let it write this note"
        className="ctx-handle"
        style={ctxHandleStyle(palette.accent, 'top', 'square')}
      />
      {/* the context connector: drag this square onto a chat's circle — or
          tap it and the arrow follows the cursor until a click on a chat
          commits (ContextConnectOverlay) — to feed the note into that chat's
          system prompt */}
      <Handle
        id={CTX_HANDLE_ID}
        type="source"
        position={Position.Bottom}
        isConnectable
        isConnectableEnd={false}
        title="Drag — or tap, then click a chat — to attach this note as context"
        onClick={(e) => {
          // keep the tap from reaching the overlay's window listener,
          // which treats any stray click as cancel
          e.stopPropagation()
          setCtxConnectSource(armed ? null : id)
        }}
        className={`ctx-handle ${armed ? 'ctx-armed' : ''}`}
        style={ctxHandleStyle(palette.accent, 'bottom', 'square')}
      />

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

      {/* colored header band — the note's "tab of sticky tape" */}
      <div
        style={{ backgroundColor: palette.bg }}
        className={`${DRAG_HEADER} flex shrink-0 items-center gap-2 px-3 py-1.5 ${
          data.minimized ? 'rounded-[13px]' : 'rounded-t-[13px] border-b border-(--np-edge)'
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
            placeholder="Untitled note"
            onChange={(e) => setTitle(id, e.target.value)}
            onBlur={() => {
              setEditingTitle(false)
              if (duplicate) revert()
              else void commitNoteTitle(id) // the file is renamed to match the title
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                if (duplicate) return // a colliding title can't be committed
                setEditingTitle(false)
                void commitNoteTitle(id)
                editorRef.current?.focus()
              } else if (e.key === 'Escape') {
                if (blank) discardNode(id)
                else if (duplicate) {
                  revert()
                  setEditingTitle(false)
                } else {
                  setEditingTitle(false)
                  void commitNoteTitle(id)
                }
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
            className={`min-w-0 flex-1 truncate text-[26px] font-medium text-(--np-deep) ${data.title ? '' : 'opacity-50'} ${awaitingTitle ? 'animate-pulse tracking-widest' : ''}`}
          >
            {awaitingTitle ? '●●●' : data.title || 'Untitled note'}
          </span>
        )}
        {data.minimized && streaming && (
          <span className="shrink-0 animate-pulse tracking-widest text-neutral-400">●●●</span>
        )}
        <div className="nodrag relative ml-auto flex shrink-0 items-center gap-1">
          {!data.minimized && (
            <TitleEditSlot
              editing={editingTitle}
              duplicate={duplicate}
              onEdit={() => setEditingTitle(true)}
              renameHint="Rename this note"
            />
          )}
          {!data.minimized && <TransformButton id={id} />}
          <button
            type="button"
            onClick={() => requestDelete(id)}
            title="Delete this note"
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
          <NoteBody id={id} focused={!!selected} editorRef={editorRef} />
        ))}

      {/* Version pager — floats just below the card's bottom-right, clear of
          the centered context connector. Only appears once a note has history
          (an AI turn has touched it), and never while it's collapsed/docked. */}
      {!data.minimized && !docked && total > 1 && (
        <div className="nodrag absolute top-full right-2 mt-1.5 flex items-center gap-0.5">

          <button
            type="button"
            onClick={() => goTo(position - 1)}
            disabled={streaming || position <= 1}
            title="Older version"
            className={`${CHIP_BUTTON} disabled:cursor-default disabled:opacity-30 disabled:hover:bg-transparent`}
          >
            <ChevronLeft className="h-[22px] w-[22px]" />
          </button>
          <span className="px-1 text-[18px] font-medium whitespace-nowrap text-(--np-deep) tabular-nums">
            {position}/{total}
          </span>
          <button
            type="button"
            onClick={() => goTo(position + 1)}
            disabled={streaming || position >= total}
            title="Newer version"
            className={`${CHIP_BUTTON} disabled:cursor-default disabled:opacity-30 disabled:hover:bg-transparent`}
          >
            <ChevronRight className="h-[22px] w-[22px]" />
          </button>
        </div>
      )}
    </div>
  )
}

export default memo(NoteNodeView)
