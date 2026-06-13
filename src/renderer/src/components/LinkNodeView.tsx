import { memo, useEffect, useRef, useState } from 'react'
import {
  Handle,
  NodeResizeControl,
  Position,
  ResizeControlVariant,
  type NodeProps
} from '@xyflow/react'
import { Minus, Trash2 } from 'lucide-react'
import { useCanvasStore, MAX_NODE_H, type LinkNode } from '../store/canvas'
import { paletteFor } from '../lib/palette'
import { usePanel } from '../lib/usePanel'
import TabBrowser, { LinkSearch } from './TabBrowser'
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
import { useTitleGuard } from '../lib/titleGuard'
import TitleEditSlot from './TitleEditSlot'

// Same paper fill as notes and file nodes.
const PAPER = '#FFFDF6'

// Pages scroll inside the card, so the frame is a window — resize freely.
const RESIZE_LIMITS = { minWidth: 280, minHeight: 160, maxHeight: MAX_NODE_H }

function LinkNodeView({ id, data, selected }: NodeProps<LinkNode>): React.JSX.Element {
  const setTitle = useCanvasStore((s) => s.setTitle)
  const requestDelete = useCanvasStore((s) => s.requestDelete)
  const toggleMinimize = useCanvasStore((s) => s.toggleMinimize)
  const setCtxConnectSource = useCanvasStore((s) => s.setCtxConnectSource)
  const armed = useCanvasStore((s) => s.ctxConnectSource === id)
  const { docked, mode, open, collapse } = usePanel(id)

  const titleRef = useRef<HTMLInputElement>(null)

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

  const palette = paletteFor(data.color)

  // A live tab's header is buttons-only — the toolbar's address bar already
  // says where it is. Title and URL text return on the minimized chip, and
  // on the stub card while the tab is docked in the side panel.
  const bare = !!data.url && !data.minimized && !docked

  return (
    <div
      style={
        {
          backgroundColor: PAPER,
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
      {/* hidden layout anchors (left/right) for any future edges */}
      <Handle type="target" position={Position.Left} isConnectable={false} style={HIDDEN_HANDLE} />
      <Handle type="source" position={Position.Right} isConnectable={false} style={HIDDEN_HANDLE} />
      {/* the context connector: drag this square onto a chat's circle — or
          tap it and the arrow follows the cursor until a click on a chat
          commits (ContextConnectOverlay) — to let that chat read this page
          (each send extracts the rendered page from this tab's guest;
          WebFetch is the fallback when the guest isn't mounted). A square
          because, like a note, a tab is a resource. */}
      <Handle
        id={CTX_HANDLE_ID}
        type="source"
        position={Position.Bottom}
        isConnectable
        isConnectableEnd={false}
        title="Drag — or tap, then click a chat — to attach this page as context"
        onClick={(e) => {
          // keep the tap from reaching the overlay's window listener,
          // which treats any stray click as cancel
          e.stopPropagation()
          setCtxConnectSource(armed ? null : id)
        }}
        className={`ctx-handle ${armed ? 'ctx-armed' : ''}`}
        style={ctxHandleStyle(palette.accent, 'bottom', 'square')}
      />

      {!data.minimized && data.url && (
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

      {/* colored header band, same chrome as chats, notes, and files — on a
          live tab it carries only the chip buttons: the browser toolbar below
          already shows the address, so title and URL text would be noise */}
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
        {bare ? (
          <span className="min-w-0 flex-1" />
        ) : editingTitle && !data.minimized ? (
          <input
            ref={titleRef}
            value={data.title}
            placeholder="Untitled tab"
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
            {data.title || 'Untitled tab'}
          </span>
        )}
        {/* where the tab is right now — data.url tracks every navigation, so
            this reads true even minimized or zoomed out (title is flex-1, so
            the URL sits against the buttons) */}
        {data.url && !bare && (
          <span
            title={data.url}
            className="max-w-[45%] shrink-[2] truncate text-[17px] text-(--np-deep) opacity-60"
          >
            {data.url.replace(/^https?:\/\/(www\.)?/, '')}
          </span>
        )}
        <div className="nodrag relative ml-auto flex shrink-0 items-center gap-1">
          {!data.minimized && !bare && (
            <TitleEditSlot
              editing={editingTitle}
              duplicate={duplicate}
              onEdit={() => setEditingTitle(true)}
              renameHint="Rename this tab"
            />
          )}
          {!data.minimized && <TransformButton id={id} />}
          <button
            type="button"
            onClick={() => requestDelete(id)}
            title="Delete this tab"
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
          // The body is the page (scroll, not drag) — only the header band
          // moves the node, like chats and notes.
          <div className="min-h-0 flex-1 overflow-hidden rounded-b-[13px]">
            {!data.url ? (
              <LinkSearch id={id} active={!data.minimized} />
            ) : (
              <TabBrowser id={id} url={data.url} focused={!!selected} />
            )}
          </div>
        ))}
    </div>
  )
}

export default memo(LinkNodeView)
