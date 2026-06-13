import { memo, useEffect, useRef, useState } from 'react'
import {
  Handle,
  NodeResizeControl,
  Position,
  ResizeControlVariant,
  type NodeProps
} from '@xyflow/react'
import { Minus, Pencil, Trash2 } from 'lucide-react'
import { useCanvasStore, MAX_NODE_H, type FileNode } from '../store/canvas'
import { paletteFor } from '../lib/palette'
import { usePanel } from '../lib/usePanel'
import FileBody from './FileBody'
import DockedStub from './DockedStub'
import PanelChips from './PanelChips'
import TransformButton from './TransformButton'
import TransformFrame from './TransformFrame'
import {
  CHIP_BUTTON,
  CTX_HANDLE_ID,
  ctxHandleStyle,
  DRAG_HEADER,
  HIDDEN_HANDLE
} from '../lib/nodeChrome'

// Same paper fill as notes — it shows through as letterboxing when the node's
// box drifts off the image's aspect ratio.
const PAPER = '#FFFDF6'

// Images resize aspect-locked so the picture always (nearly) fills the frame —
// Figma-style corner/edge scaling. PDFs resize freely: their pages scroll, so
// the frame is a window, not a fit.
const RESIZE_LIMITS = { minWidth: 240, minHeight: 120, maxHeight: MAX_NODE_H }

function FileNodeView({ id, data, selected }: NodeProps<FileNode>): React.JSX.Element {
  const setTitle = useCanvasStore((s) => s.setTitle)
  const requestDelete = useCanvasStore((s) => s.requestDelete)
  const toggleMinimize = useCanvasStore((s) => s.toggleMinimize)
  const setCtxConnectSource = useCanvasStore((s) => s.setCtxConnectSource)
  const armed = useCanvasStore((s) => s.ctxConnectSource === id)
  const { docked, mode, open, collapse } = usePanel(id)

  const titleRef = useRef<HTMLInputElement>(null)
  const isPdf = data.kind === 'pdf'
  const untitled = isPdf ? 'Untitled PDF' : 'Untitled image'

  // The title is static text (part of the header drag surface) until the user
  // enters rename mode via the pencil button or a double-click on the title.
  // Renaming relabels the node only — the file keeps its name.
  const [editingTitle, setEditingTitle] = useState(false)
  if (data.minimized && editingTitle) setEditingTitle(false)

  useEffect(() => {
    if (!editingTitle) return
    titleRef.current?.focus()
    titleRef.current?.select()
  }, [editingTitle])

  const palette = paletteFor(data.color)

  return (
    <div
      style={
        {
          backgroundColor: `${PAPER}D9`,
          '--np-bg': palette.bg,
          '--np-edge': palette.edge,
          '--np-chip': `${palette.edge}99`,
          '--np-accent': palette.accent,
          '--np-deep': palette.deep,
          '--np-ring': `${palette.accent}B3`
        } as React.CSSProperties
      }
      className={`relative flex h-full w-full flex-col rounded-[14px] border border-(--np-edge) shadow-md ${
        selected ? 'ring-2 ring-(--np-ring)' : ''
      }`}
    >
      <TransformFrame id={id} />
      {/* hidden layout anchors (left/right) for any future edges */}
      <Handle type="target" position={Position.Left} isConnectable={false} style={HIDDEN_HANDLE} />
      <Handle type="source" position={Position.Right} isConnectable={false} style={HIDDEN_HANDLE} />
      {/* the context connector: drag this circle onto a chat's circle — or
          tap it and the arrow follows the cursor until a click on a chat
          commits (ContextConnectOverlay) — to let that chat see this file */}
      <Handle
        id={CTX_HANDLE_ID}
        type="source"
        position={Position.Bottom}
        isConnectable
        isConnectableEnd={false}
        title="Drag — or tap, then click a chat — to attach this file as context"
        onClick={(e) => {
          // keep the tap from reaching the overlay's window listener,
          // which treats any stray click as cancel
          e.stopPropagation()
          setCtxConnectSource(armed ? null : id)
        }}
        className={`ctx-handle ${armed ? 'ctx-armed' : ''}`}
        style={ctxHandleStyle(palette.accent, 'bottom')}
      />

      {!data.minimized && (
        <>
          <NodeResizeControl
            position="right"
            variant={ResizeControlVariant.Line}
            keepAspectRatio={!isPdf}
            {...RESIZE_LIMITS}
            style={{ borderColor: 'transparent', borderWidth: 5 }}
          />
          <NodeResizeControl
            position="bottom"
            variant={ResizeControlVariant.Line}
            keepAspectRatio={!isPdf}
            {...RESIZE_LIMITS}
            style={{ borderColor: 'transparent', borderWidth: 5 }}
          />
          <NodeResizeControl
            position="bottom-right"
            keepAspectRatio={!isPdf}
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

      {/* colored header band, same chrome as chats and notes */}
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
        <PanelChips mode={mode} open={open} />
        {editingTitle && !data.minimized ? (
          <input
            ref={titleRef}
            value={data.title}
            placeholder={untitled}
            onChange={(e) => setTitle(id, e.target.value)}
            onBlur={() => setEditingTitle(false)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === 'Escape') {
                e.preventDefault()
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
            {data.title || untitled}
          </span>
        )}
        <div className="nodrag relative ml-auto flex shrink-0 items-center gap-1">
          {!data.minimized && (
            <button
              type="button"
              onClick={() => setEditingTitle(true)}
              title={isPdf ? 'Rename this PDF' : 'Rename this image'}
              className={CHIP_BUTTON}
            >
              <Pencil className="h-[25px] w-[25px]" />
            </button>
          )}
          {!data.minimized && <TransformButton id={id} />}
          <button
            type="button"
            onClick={() => requestDelete(id)}
            title={isPdf ? 'Delete this PDF' : 'Delete this image'}
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
          // Images: the whole body is a drag surface — grab anywhere to move
          // the node. PDFs: the body is the viewer (scroll, not drag) — only
          // the header band moves the node, like chats and notes.
          <div
            className={`${isPdf ? '' : DRAG_HEADER} min-h-0 flex-1 overflow-hidden rounded-b-[13px]`}
          >
            <FileBody id={id} focused={!!selected} />
          </div>
        ))}
    </div>
  )
}

export default memo(FileNodeView)
