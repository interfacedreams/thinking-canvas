import { memo, useEffect, useRef, useState } from 'react'
import {
  Handle,
  NodeResizeControl,
  Position,
  ResizeControlVariant,
  useReactFlow,
  type NodeProps
} from '@xyflow/react'
import Markdown from 'react-markdown'
import { ChevronLeft, ChevronRight, Expand, History, Minus, Pencil, Trash2 } from 'lucide-react'
import { useCanvasStore, MAX_NODE_H, type NoteNode } from '../store/canvas'
import { paletteFor } from '../lib/palette'
import { useForwardedWheel } from '../lib/useForwardedWheel'
import { CHIP_BUTTON, DRAG_HEADER, HIDDEN_HANDLE } from '../lib/nodeChrome'
import NoteEditor, { type NoteEditorHandle } from './NoteEditor'

// Notes read as paper, not post-it: a warm-white ruled body under a colored
// header band (chats are solid colored cards).
const PAPER = '#FFFDF6'

function NoteNodeView({ id, data, selected }: NodeProps<NoteNode>): React.JSX.Element {
  const setTitle = useCanvasStore((s) => s.setTitle)
  const commitNoteTitle = useCanvasStore((s) => s.commitNoteTitle)
  const setNoteContent = useCanvasStore((s) => s.setNoteContent)
  const setViewVersion = useCanvasStore((s) => s.setViewVersion)
  const restoreVersion = useCanvasStore((s) => s.restoreVersion)
  const requestDelete = useCanvasStore((s) => s.requestDelete)
  const discardNode = useCanvasStore((s) => s.discardNode)
  const toggleMinimize = useCanvasStore((s) => s.toggleMinimize)
  const clearFocusDraft = useCanvasStore((s) => s.clearFocusDraft)
  const explicitHeight = useCanvasStore((s) => s.nodes.find((n) => n.id === id)?.height)
  const { fitView } = useReactFlow()

  const titleRef = useRef<HTMLInputElement>(null)
  const editorRef = useRef<NoteEditorHandle>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  const streaming = data.status === 'streaming'
  const palette = paletteFor(data.color)

  // Version pager. Positions 1..total, where the last position is always the
  // live (editable) content. When the live content has drifted from the latest
  // snapshot — unversioned user edits — it earns its own extra position.
  const versions = data.versions
  const drifted = versions.length > 0 && data.content !== versions[versions.length - 1].content
  const total = versions.length === 0 ? 1 : versions.length + (drifted ? 1 : 0)
  const viewingOld = data.viewVersion !== undefined && data.viewVersion < versions.length
  const position = viewingOld ? data.viewVersion! + 1 : total
  const goTo = (p: number): void => {
    const clamped = Math.min(Math.max(p, 1), total)
    setViewVersion(id, clamped >= total ? undefined : clamped - 1)
  }

  // A note is discardable while it has no substance yet.
  const blank = !data.content && !data.title && versions.length === 0 && !data.sessionId

  // Scrolling the note body requires focus (the node is selected by clicking
  // it); otherwise the wheel pans the canvas.
  useForwardedWheel(scrollRef, !data.minimized, !!selected)

  // The title is static text (part of the header drag surface) until the user
  // enters rename mode via the pencil button or a double-click on the title.
  // State adjustments happen during render (not effects): a fresh note
  // (button / ⇧⌘N / alt+double-click) opens in rename mode so it can be named
  // first, and minimizing exits rename because the input unmounts blur-less.
  const [editingTitle, setEditingTitle] = useState(false)
  if (data.minimized && editingTitle) setEditingTitle(false)
  else if (data.focusDraft && !editingTitle) setEditingTitle(true)

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
      style={
        {
          maxHeight: explicitHeight ?? data.growthCap ?? MAX_NODE_H,
          backgroundColor: `${PAPER}D9`, // paper fill at 85%, matching chat nodes
          '--np-bg': palette.bg,
          '--np-edge': palette.edge,
          '--np-chip': `${palette.edge}99`,
          '--np-accent': palette.accent,
          '--np-deep': palette.deep,
          '--np-ring': `${palette.accent}B3`
        } as React.CSSProperties
      }
      className={`flex h-full w-full flex-col rounded-[14px] border border-(--np-edge) shadow-md ${
        selected ? 'ring-2 ring-(--np-ring)' : ''
      }`}
    >
      {/* anchors so future note↔chat edges have somewhere to attach */}
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

      {/* colored header band — the note's "tab of sticky tape" */}
      <div
        style={{ backgroundColor: `${palette.bg}D9` }}
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
            placeholder="Untitled note"
            onChange={(e) => setTitle(id, e.target.value)}
            onBlur={() => {
              setEditingTitle(false)
              void commitNoteTitle(id) // the file is renamed to match the title
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                setEditingTitle(false)
                void commitNoteTitle(id)
                editorRef.current?.focus()
              } else if (e.key === 'Escape') {
                if (blank) discardNode(id)
                else {
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
            className={`min-w-0 flex-1 truncate text-[26px] font-medium text-(--np-deep) ${data.title ? '' : 'opacity-50'}`}
          >
            {data.title || 'Untitled note'}
          </span>
        )}
        <div className="nodrag relative ml-auto flex shrink-0 items-center gap-1">
          {!data.minimized && (
            <button
              type="button"
              onClick={() => setEditingTitle(true)}
              title="Rename this note"
              className={CHIP_BUTTON}
            >
              <Pencil className="h-[25px] w-[25px]" />
            </button>
          )}
          {!data.minimized && total > 1 && (
            <div className="mr-1 flex items-center gap-0.5">
              <button
                type="button"
                onClick={() => goTo(position - 1)}
                disabled={streaming || position <= 1}
                title="Older version"
                className={`${CHIP_BUTTON} disabled:cursor-default disabled:opacity-30 disabled:hover:bg-(--np-chip)`}
              >
                <ChevronLeft className="h-[25px] w-[25px]" />
              </button>
              <span className="px-1 text-[22px] font-medium whitespace-nowrap text-(--np-deep) tabular-nums">
                {position}/{total}
              </span>
              <button
                type="button"
                onClick={() => goTo(position + 1)}
                disabled={streaming || position >= total}
                title="Newer version"
                className={`${CHIP_BUTTON} disabled:cursor-default disabled:opacity-30 disabled:hover:bg-(--np-chip)`}
              >
                <ChevronRight className="h-[25px] w-[25px]" />
              </button>
            </div>
          )}
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

      {!data.minimized && (
        <div className="nodrag mx-1 my-1 flex min-h-0 flex-1 cursor-auto flex-col overflow-hidden">
          {viewingOld && (
            <div className="mt-1 mb-1 flex shrink-0 items-center gap-2 rounded-[10px] bg-black/5 px-3 py-1.5 text-[12px] text-neutral-600">
              <History className="h-3.5 w-3.5 shrink-0 text-(--np-deep)" />
              <span className="min-w-0 flex-1 truncate">
                Version {position} of {total} ·{' '}
                {versions[data.viewVersion!].author === 'ai' ? 'AI' : 'you'} · read-only
              </span>
              <button
                type="button"
                onClick={() => void restoreVersion(id, data.viewVersion!)}
                className="shrink-0 cursor-pointer rounded-md bg-(--np-accent) px-2 py-0.5 font-medium text-white transition-colors hover:opacity-85"
              >
                Restore
              </button>
            </div>
          )}
          <div
            ref={scrollRef}
            style={{
              // ruled notepad lines, aligned to the 26px text grid and tinted
              // to the palette; `local` makes them scroll with the content
              backgroundImage: `repeating-linear-gradient(to bottom, transparent 0, transparent 25px, ${palette.edge}59 25px, ${palette.edge}59 26px)`,
              backgroundAttachment: 'local',
              backgroundPosition: '0 8px'
            }}
            className="nowheel select-text transcript-scroll min-h-0 flex-1 overflow-x-hidden overflow-y-auto pb-1 text-[15px] leading-[26px] text-neutral-900"
          >
            {viewingOld ? (
              <div className="note-prose px-3 py-2 break-words opacity-80">
                {versions[data.viewVersion!].content ? (
                  <Markdown>{versions[data.viewVersion!].content}</Markdown>
                ) : (
                  <span className="text-neutral-400 italic">Empty version</span>
                )}
              </div>
            ) : (
              <NoteEditor
                ref={editorRef}
                content={data.content}
                readOnly={streaming}
                onChange={(md) => setNoteContent(id, md)}
                onEscape={() => {
                  if (blank) discardNode(id)
                }}
              />
            )}
          </div>
        </div>
      )}
    </div>
  )
}

export default memo(NoteNodeView)
