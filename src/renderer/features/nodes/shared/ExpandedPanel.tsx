import { Maximize2, MessageSquarePlus, PanelRight, X } from 'lucide-react'
import { useReactFlow } from '@xyflow/react'
import { useCanvasStore, isChat, isFile, isLink, isNote } from '@renderer/store/canvas'
import { paletteFor } from '@renderer/lib/palette'
import { CHIP_BUTTON, CHIP_BUTTON_ACTIVE } from '@renderer/features/nodes/shared/nodeChrome'
import ChatBody from '@renderer/features/nodes/chat/ChatBody'
import NoteBody from '@renderer/features/nodes/note/NoteBody'
import FileBody from '@renderer/features/nodes/file/FileBody'
import TabBrowser, { LinkSearch } from '@renderer/features/nodes/link/TabBrowser'

// Same paper fill as the paper-bodied nodes (notes, files, tabs).
const PAPER = '#FFFDF6'

/**
 * The reading surface: one node's content at full height, in either of two
 * sizes. 'panel' docks it to the right so the canvas stays live beside it —
 * read an article and take notes on the board at once. 'full' covers the whole
 * window for distraction-free reading. Both render the same body, so flipping
 * between them never remounts a webview. The node's canvas card swaps its body
 * for a stub (its content can only be mounted once — a webview enforces that,
 * the rest follow for symmetry) and keeps wearing its chrome: rename, delete,
 * edges, all stay on the card. Esc, the close chip here, or the card's chip
 * closes it; the other-mode chip flips between the two sizes.
 *
 * Solid fills throughout — the canvas must not ghost through a reading
 * surface.
 */
export default function ExpandedPanel(): React.JSX.Element | null {
  const node = useCanvasStore((s) => {
    const id = s.expanded?.id
    return id ? (s.nodes.find((n) => n.id === id) ?? null) : null
  })
  const mode = useCanvasStore((s) => s.expanded?.mode ?? null)
  const expandNode = useCanvasStore((s) => s.expandNode)
  const collapseExpanded = useCanvasStore((s) => s.collapseExpanded)
  const chatAbout = useCanvasStore((s) => s.chatAbout)
  const { screenToFlowPosition, setCenter, getViewport } = useReactFlow()
  if (!node || !mode) return null

  // Drop a "chat about this" chat in the middle of the canvas left of the
  // panel. The React Flow pane is the flex sibling that fills everything not
  // covered by the half-sheet, so the visible canvas spans client x 0 → that
  // width; its center, projected into flow space, is where we want the chat.
  // Then frame it: pan onto that center and come in to a readable 100% when
  // zoomed out, never zooming out from closer (mirrors the double-click spawn).
  const chatAboutCentered = (): void => {
    const panelW = Math.min(window.innerWidth * 0.52, 880)
    const center = screenToFlowPosition({
      x: (window.innerWidth - panelW) / 2,
      y: window.innerHeight / 2
    })
    chatAbout(node.id, center)
    void setCenter(center.x, center.y, {
      zoom: Math.max(getViewport().zoom, 1),
      duration: 250
    })
  }

  const full = mode === 'full'
  // Full screen spans the whole window — far wider than a comfortable reading
  // measure. Text bodies (chat, notes) center in a fixed reading column;
  // webviews and files still fill the width. The side panel is already narrow.
  const reading = full ? 'mx-auto w-full max-w-3xl' : ''

  const data = node.data
  const palette = paletteFor(data.color)
  const chat = isChat(node)
  const untitled = chat
    ? 'New chat'
    : isNote(node)
      ? 'Untitled note'
      : isLink(node)
        ? 'Untitled tab'
        : node.data.kind === 'pdf'
          ? 'Untitled PDF'
          : 'Untitled image'

  return (
    <aside
      style={
        {
          backgroundColor: chat ? palette.bg : PAPER,
          '--np-bg': palette.bg,
          '--np-edge': palette.edge,
          '--np-chip': `${palette.edge}99`,
          '--np-accent': palette.accent,
          '--np-deep': palette.deep,
          '--np-ring': `${palette.accent}B3`
        } as React.CSSProperties
      }
      className={
        full
          ? 'fixed inset-0 z-40 flex flex-col'
          : 'flex h-screen w-[min(52vw,880px)] shrink-0 flex-col border-l border-(--np-edge)'
      }
    >
      {/* colored header band — the same chrome the node wears on the canvas.
          Its content stays hard-left in both modes (the close/size controls and
          title live in the corner), full-width. */}
      <div
        style={{ backgroundColor: palette.bg }}
        className="shrink-0 border-b border-(--np-edge) px-3 py-1.5"
      >
        <div className="flex w-full items-center gap-2">
          {/* close + size controls on the left, mirroring the node card's
              chrome. The X closes back to the canvas card; full and half-sheet
              are always both present (click either to switch), with the current
              size highlighted as a "you are here" marker. */}
          <button
            type="button"
            onClick={collapseExpanded}
            title="Close (Esc)"
            className={CHIP_BUTTON}
          >
            <X className="h-[25px] w-[25px]" />
          </button>
          <button
            type="button"
            onClick={() => expandNode(node.id, 'panel')}
            title="Half sheet"
            className={full ? CHIP_BUTTON : CHIP_BUTTON_ACTIVE}
          >
            <PanelRight className="h-[25px] w-[25px]" />
          </button>
          <button
            type="button"
            onClick={() => expandNode(node.id, 'full')}
            title="Full screen"
            className={full ? CHIP_BUTTON_ACTIVE : CHIP_BUTTON}
          >
            <Maximize2 className="h-[22px] w-[22px]" />
          </button>
          {/* Links carry their address in the browser toolbar just below, so a
              title here would only repeat it — leave the header a bare spacer. */}
          {isLink(node) ? (
            <span className="min-w-0 flex-1" />
          ) : (
            <span
              className={`min-w-0 flex-1 truncate text-[26px] font-medium text-(--np-deep) ${
                data.title ? '' : 'opacity-50'
              }`}
            >
              {data.title || untitled}
            </span>
          )}
          {/* "Chat about this": for any readable resource (note/file/link) in
              the half-sheet (full screen is single-doc reading). Spawns a chat
              wired to read this resource, dropped in the center of the live
              canvas beside the panel — the reliable path when a webview holds
              focus, and the visible twin of the C accelerator. */}
          {!full && (isNote(node) || isFile(node) || isLink(node)) && (
            <button
              type="button"
              onClick={chatAboutCentered}
              title="Chat about this (C)"
              className={CHIP_BUTTON}
            >
              <MessageSquarePlus className="h-[23px] w-[23px]" />
            </button>
          )}
        </div>
      </div>

      {chat ? (
        <div className={`flex min-h-0 flex-1 flex-col px-2 ${reading}`}>
          <ChatBody id={node.id} focused inPanel />
        </div>
      ) : isNote(node) ? (
        <div className={`flex min-h-0 flex-1 flex-col px-2 pb-1 ${reading}`}>
          <NoteBody id={node.id} focused inPanel />
        </div>
      ) : isLink(node) ? (
        <div className="min-h-0 flex-1 overflow-hidden">
          {node.data.url ? (
            <TabBrowser id={node.id} url={node.data.url} focused swipeNav />
          ) : (
            <LinkSearch id={node.id} active />
          )}
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-hidden">
          <FileBody id={node.id} focused />
        </div>
      )}
    </aside>
  )
}
