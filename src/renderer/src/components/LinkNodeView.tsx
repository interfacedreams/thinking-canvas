import { memo, useEffect, useRef, useState } from 'react'
import {
  Handle,
  NodeResizeControl,
  Position,
  ResizeControlVariant,
  type NodeProps
} from '@xyflow/react'
import { Brain, Minus, Plus, Trash2 } from 'lucide-react'
import { useCanvasStore, MAX_NODE_H, type LinkNode } from '../store/canvas'
import { paletteFor } from '../lib/palette'
import { usePanel } from '../lib/usePanel'
import TabBrowser, { LinkSearch } from './TabBrowser'
import DockedStub from './DockedStub'
import PanelChips from './PanelChips'
import TransformButton from './TransformButton'
import Tooltip from './Tooltip'
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
  const deleteChat = useCanvasStore((s) => s.deleteChat)
  const togglePin = useCanvasStore((s) => s.togglePin)
  const toggleMinimize = useCanvasStore((s) => s.toggleMinimize)
  const setCtxConnectSource = useCanvasStore((s) => s.setCtxConnectSource)
  const armed = useCanvasStore((s) => s.ctxConnectSource === id)
  // Shift held: float a transparent host-DOM layer over the live <webview> so a
  // shift+click on the page surfaces as a normal DOM click (the guest otherwise
  // swallows it) and the canvas's connect listener can read this node's id.
  const shiftHeld = useCanvasStore((s) => s.shiftHeld)
  const { docked, mode, open, stubAction } = usePanel(id)

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
          '--np-bg': palette.bg,
          '--np-edge': palette.edge,
          '--np-chip': `${palette.edge}99`,
          '--np-accent': palette.accent,
          '--np-deep': palette.deep,
          '--np-ring': `${palette.accent}B3`
        } as React.CSSProperties
      }
      className={`relative isolate flex h-full w-full flex-col rounded-[14px] border border-(--np-edge) shadow-md ${
        // Hold the full browser height even while docked (the stub centers in it),
        // so the card's box — and every edge/placement anchored to it — stays put
        // when the page pops into the side panel. Matches files and chats.
        selected ? 'ring-2 ring-(--np-ring)' : ''
      }`}
    >
      <TransformFrame id={id} />
      {/* Opaque card fill — above the transform tab (deeper negative z), below
          all content, so the tab can't bleed through the card's corners/edges. */}
      <div
        aria-hidden
        className="absolute inset-0 rounded-[14px]"
        style={{ backgroundColor: PAPER, zIndex: -1 }}
      />
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
        position={Position.Right}
        isConnectable
        isConnectableEnd={false}
        title={
          data.pinned
            ? 'In memory — its clipped page is pulled in on demand. Drag to also wire it into a chat.'
            : 'Drag — or tap, then click a chat — to attach this page as context'
        }
        onClick={(e) => {
          // keep the tap from reaching the overlay's window listener,
          // which treats any stray click as cancel
          e.stopPropagation()
          setCtxConnectSource(armed ? null : id)
        }}
        className={`ctx-handle ${armed ? 'ctx-armed' : ''}`}
        style={{
          ...ctxHandleStyle(palette.accent, 'right', 'square'),
          // In memory: a white brain rides inside the knob (mirrors notes/files),
          // faded to read as "optional — already in memory".
          ...(data.pinned
            ? {
                width: 36,
                height: 36,
                right: -24,
                opacity: 0.85,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center'
              }
            : {})
        }}
      >
        {data.pinned && <Brain className="pointer-events-none h-4 w-4 text-white" />}
      </Handle>

      {!data.minimized && !docked && data.url && (
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
        {bare ? (
          <span className="min-w-0 flex-1" />
        ) : docked ? (
          // Docked in the side panel: the card is a stub, so its header is just
          // a where-it-is marker — show the URL alone, no rename/transform combo.
          <span
            title={data.url}
            className="min-w-0 flex-1 truncate text-[17px] text-(--np-deep) opacity-60"
          >
            {data.url ? data.url.replace(/^https?:\/\/(www\.)?/, '') : 'Untitled tab'}
          </span>
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
        {data.url && !bare && !docked && (
          <span
            title={data.url}
            className="max-w-[45%] shrink-[2] truncate text-[17px] text-(--np-deep) opacity-60"
          >
            {data.url.replace(/^https?:\/\/(www\.)?/, '')}
          </span>
        )}
        <div className="nodrag relative ml-auto flex shrink-0 items-center gap-1">
          {!data.minimized && !bare && !docked && (
            <TitleEditSlot
              editing={editingTitle}
              duplicate={duplicate}
              onEdit={() => setEditingTitle(true)}
              renameHint="Rename this tab"
            />
          )}
          {!data.minimized && !docked && data.url && (
            <Tooltip
              label={
                data.pinned
                  ? 'In project memory — every new chat sees this page'
                  : 'Add this page to project memory'
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
          {!data.minimized && !docked && <TransformButton id={id} />}
          <Tooltip label="Delete this tab">
            <button type="button" onClick={() => deleteChat(id, false)} className={CHIP_BUTTON}>
              <Trash2 className="h-[25px] w-[25px]" />
            </button>
          </Tooltip>
        </div>
      </div>

      {!data.minimized &&
        (docked ? (
          <DockedStub onClick={stubAction} />
        ) : (
          // The body is the page (scroll, not drag) — only the header band
          // moves the node, like chats and notes.
          <div className="relative min-h-0 flex-1 overflow-hidden rounded-b-[13px]">
            {!data.url ? (
              <LinkSearch id={id} active={!data.minimized} />
            ) : (
              <TabBrowser id={id} url={data.url} focused={!!selected} />
            )}
            {/* Shift-to-connect catch layer: only while Shift is held, and only
                over a live page (the guest swallows clicks; LinkSearch is plain
                host DOM and needs no help). Transparent, but its crosshair hints
                that a click now wires this page to a chat. The canvas listener
                resolves the click to this node via the wrapping .react-flow__node. */}
            {shiftHeld && data.url && (
              <div className="nodrag absolute inset-0 z-10 cursor-crosshair" />
            )}
          </div>
        ))}
    </div>
  )
}

export default memo(LinkNodeView)
