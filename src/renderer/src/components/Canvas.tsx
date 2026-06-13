import { useCallback, useEffect, useRef } from 'react'
import {
  Background,
  BackgroundVariant,
  MarkerType,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Connection,
  type EdgeTypes,
  type NodeTypes
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import ChatNodeView from './ChatNodeView'
import NoteNodeView from './NoteNodeView'
import FileNodeView from './FileNodeView'
import LinkNodeView from './LinkNodeView'
import ForkEdge from './ForkEdge'
import ContextEdge from './ContextEdge'
import DeriveEdge from './DeriveEdge'
import ContextConnectOverlay from './ContextConnectOverlay'
import BeeIcon from './BeeIcon'
import ActionsLegend from './ActionsLegend'
import ModelSelector from './ModelSelector'
import EffortSelector from './EffortSelector'
import FolderChip from './FolderChip'
import Sidebar from './Sidebar'
import AuthKeyButton from './AuthKeyButton'
import SettingsButton from './SettingsButton'
import PlacementOverlay from './PlacementOverlay'
import DeleteChatModal from './DeleteChatModal'
import ExpandedPanel from './ExpandedPanel'
import { useCanvasStore, NODE_W, isChat, isNote } from '../store/canvas'
import type { ChosenFile } from '../../../shared/types'
import { CTX_HANDLE_ID, OUTPUT_HANDLE_ID, INPUT_HANDLE_ID } from '../lib/nodeChrome'
import { paletteFor } from '../lib/palette'
import { useSpawn } from '../lib/useSpawn'

const nodeTypes: NodeTypes = {
  chat: ChatNodeView,
  note: NoteNodeView,
  file: FileNodeView,
  link: LinkNodeView
}
const edgeTypes: EdgeTypes = { fork: ForkEdge, context: ContextEdge, derive: DeriveEdge }

/** The pasted text as an http(s) URL — null unless the whole paste is one
 *  link (a scheme'd URL, or a bare domain like nuwapen.com/about). */
function pastedUrl(text: string): string | null {
  const t = text.trim()
  if (!t || /\s/.test(t)) return null
  if (!/^https?:\/\//i.test(t) && !/^[\w-]+(\.[\w-]+)+([/?#]|$)/.test(t)) return null
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(t) ? t : `https://${t}`)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return url.hostname.includes('.') ? url.href : null
  } catch {
    return null
  }
}

function CanvasInner(): React.JSX.Element {
  const nodes = useCanvasStore((s) => s.nodes)
  const storeEdges = useCanvasStore((s) => s.edges)
  const loaded = useCanvasStore((s) => s.loaded)
  const folder = useCanvasStore((s) => s.folder)
  const onNodesChange = useCanvasStore((s) => s.onNodesChange)
  const addContextEdge = useCanvasStore((s) => s.addContextEdge)
  const addOutputEdge = useCanvasStore((s) => s.addOutputEdge)
  const addNodeAt = useCanvasStore((s) => s.addNodeAt)
  const addNoteAt = useCanvasStore((s) => s.addNoteAt)
  const addLinkAt = useCanvasStore((s) => s.addLinkAt)
  const addDroppedFiles = useCanvasStore((s) => s.addDroppedFiles)
  const setStoreViewport = useCanvasStore((s) => s.setViewport)
  const init = useCanvasStore((s) => s.init)
  const chooseFolder = useCanvasStore((s) => s.chooseFolder)
  // Split screen (a docked panel beside a live canvas): hide the corner pickers
  // and legends so the narrowed canvas stays uncluttered. They're hidden, not
  // unmounted, so each keeps its own collapse state for when split exits. (Full
  // screen needs no handling — its overlay already covers them.)
  const split = useCanvasStore((s) => s.expanded?.mode === 'panel')
  const { setViewport, setCenter, getViewport, fitView, screenToFlowPosition } = useReactFlow()
  const spawn = useSpawn()

  useEffect(() => {
    void init().then((vp) => {
      if (vp) void setViewport(vp)
    })
  }, [init, setViewport])

  const handleChooseFolder = useCallback(async () => {
    const vp = await chooseFolder()
    if (vp) void setViewport(vp)
  }, [chooseFolder, setViewport])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      // Esc closes the side panel. Inputs that consume Esc themselves (title
      // rename, the tab address box) preventDefault, and armed placement /
      // click-to-connect own Esc via their overlays.
      if (e.key === 'Escape' && !e.defaultPrevented) {
        const s = useCanvasStore.getState()
        if (s.expanded && !s.placing && !s.ctxConnectSource) s.collapseExpanded()
        return
      }
      if (e.metaKey || e.ctrlKey) {
        if (e.key === '0') {
          e.preventDefault()
          void fitView({ padding: 0.1, duration: 250 })
        } else if (e.key === 'n' || e.key === 'N') {
          e.preventDefault()
          spawn(e.shiftKey ? 'note' : 'chat')
        }
        return
      }
      // Bare C / N / F / T spawn a chat / note / file / tab — but only when
      // typing focus is elsewhere, so the letters still work inside inputs
      // and notes.
      if (e.altKey || e.repeat) return
      const t = e.target as HTMLElement
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable) return
      const key = e.key.toLowerCase()
      if (key === 'c' || key === 'n' || key === 'f' || key === 't') {
        e.preventDefault()
        spawn(key === 'n' ? 'note' : key === 'f' ? 'file' : key === 't' ? 'link' : 'chat')
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [fitView, spawn])

  // Releasing a connection drag on (or near — connectionRadius snaps) a
  // chat's circle commits the note/file/link → chat context edge. Only note,
  // file, and link circles can start a drag and only chat circles can end
  // one, so source/target here are already the right kinds; the store
  // re-validates.
  const handleConnect = useCallback(
    (conn: Connection) => {
      // A drag from a chat's bottom circle to a note's top square is an output
      // edge (chat writes note); everything else is a resource → chat context
      // edge. Route by node kind — the stores re-validate either way.
      const nodes = useCanvasStore.getState().nodes
      const src = nodes.find((n) => n.id === conn.source)
      const tgt = nodes.find((n) => n.id === conn.target)
      if (src && tgt && isChat(src) && isNote(tgt)) addOutputEdge(conn.source, conn.target)
      else addContextEdge(conn.source, conn.target)
      // a drag-connect landing mid click-to-connect supersedes it
      useCanvasStore.getState().setCtxConnectSource(null)
    },
    [addContextEdge, addOutputEdge]
  )

  // Electron's default for a dropped file is to navigate the window to it —
  // block that everywhere (top bar, sidebar, modals), so a missed drop is a
  // no-op instead of a blank window. Files only: text drags keep their native
  // behavior (dropping selected text into a composer still inserts it).
  useEffect(() => {
    const block = (e: DragEvent): void => {
      if (e.dataTransfer?.types.includes('Files')) e.preventDefault()
    }
    window.addEventListener('dragover', block)
    window.addEventListener('drop', block)
    return () => {
      window.removeEventListener('dragover', block)
      window.removeEventListener('drop', block)
    }
  }, [])

  // Paste lands content straight on the canvas, no placement click: a URL
  // becomes a link node already showing its page, an image on the clipboard
  // (screenshot, copied photo, Finder-copied file) becomes a file node.
  // Anchored under the cursor when it's over the canvas, else view center.
  const wrapRef = useRef<HTMLDivElement>(null)
  const lastMouse = useRef<{ x: number; y: number } | null>(null)
  useEffect(() => {
    const onPaste = (e: ClipboardEvent): void => {
      // composers, titles, and notes keep their normal paste
      const t = e.target as HTMLElement
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable) return
      if (!useCanvasStore.getState().folder?.current) return
      const dt = e.clipboardData
      if (!dt) return

      const rect = wrapRef.current?.getBoundingClientRect()
      const client =
        lastMouse.current ??
        (rect
          ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
          : { x: window.innerWidth / 2, y: window.innerHeight / 2 })
      const p = screenToFlowPosition(client)
      const point = { x: p.x, y: p.y - 24 } // same cursor anchor as every other spawn

      const files = Array.from(dt.files)
      if (files.length > 0) {
        e.preventDefault()
        void (async () => {
          // Finder-copied files carry paths — same vetting as a drop.
          const picked = (
            await Promise.all(
              files.map((f) => {
                const path = window.api.file.pathFor(f)
                return path ? window.api.file.fromPath(path) : null
              })
            )
          ).filter((c): c is ChosenFile => c !== null)
          if (picked.length > 0) return addDroppedFiles(point, picked)
          // Raw bytes (a screenshot, a copied photo) have no path — main
          // reads the clipboard image and stages it for attach.
          const chosen = await window.api.file.fromClipboard()
          if (chosen) await addDroppedFiles(point, [chosen])
        })()
        return
      }

      const url = pastedUrl(dt.getData('text/plain'))
      if (url) {
        e.preventDefault()
        addLinkAt({ x: point.x - NODE_W / 2, y: point.y }, url)
      }
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [screenToFlowPosition, addDroppedFiles, addLinkAt])

  // Images and PDFs dragged in from the OS drop as file nodes right where
  // they land — same vetting and placement as the picker, minus the dialog.
  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes('Files')) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  }, [])

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      const files = Array.from(e.dataTransfer.files)
      if (files.length === 0) return
      e.preventDefault()
      if (!useCanvasStore.getState().folder?.current) return
      // Anchor like every other spawn: the cursor lands a couple rows into
      // the header. addDroppedFiles centers each node's width on the point.
      const p = screenToFlowPosition({ x: e.clientX, y: e.clientY })
      void (async () => {
        const picked = (
          await Promise.all(
            files.map((f) => {
              // '' for path-less files (e.g. an image dragged from a browser)
              const path = window.api.file.pathFor(f)
              return path ? window.api.file.fromPath(path) : null
            })
          )
        ).filter((c): c is ChosenFile => c !== null)
        if (picked.length > 0) await addDroppedFiles({ x: p.x, y: p.y - 24 }, picked)
      })()
    },
    [screenToFlowPosition, addDroppedFiles]
  )

  // Double-click on empty canvas: spawn a chat right there, under the cursor
  // (a note with alt/option held), then center on it at a readable zoom —
  // come in to 100% when zoomed out, never zoom out from closer.
  const handleDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      if (!(e.target as HTMLElement).classList.contains('react-flow__pane')) return
      const p = screenToFlowPosition({ x: e.clientX, y: e.clientY })
      const position = { x: p.x - NODE_W / 2, y: p.y - 24 }
      if (e.altKey) addNoteAt(position)
      else addNodeAt(position)
      void setCenter(position.x + NODE_W / 2, position.y + 150, {
        zoom: Math.max(getViewport().zoom, 1),
        duration: 250
      })
    },
    [addNodeAt, addNoteAt, screenToFlowPosition, setCenter, getViewport]
  )

  return (
    <div className="flex h-screen w-screen bg-[#FBFAF4]">
      <div
        ref={wrapRef}
        className="relative h-full min-w-0 flex-1"
        onDragOver={handleDragOver}
        onDrop={handleDrop}
        onMouseMove={(e) => {
          lastMouse.current = { x: e.clientX, y: e.clientY }
        }}
        onMouseLeave={() => {
          lastMouse.current = null
        }}
      >
        {loaded && (
          <ReactFlow
            nodes={nodes}
            edges={storeEdges.map((e) => {
              const accent = paletteFor(nodes.find((n) => n.id === e.source)?.data.color).accent
              if (e.kind === 'context') {
                // context connectors run top circle → top circle in the
                // note's accent, arrowhead marking which way context flows
                return {
                  id: e.id,
                  source: e.source,
                  target: e.target,
                  sourceHandle: CTX_HANDLE_ID,
                  targetHandle: CTX_HANDLE_ID,
                  type: 'context',
                  style: { stroke: accent, strokeWidth: 3 },
                  markerEnd: {
                    type: MarkerType.ArrowClosed,
                    color: accent,
                    width: 14,
                    height: 14
                  },
                  focusable: false,
                  selectable: false
                }
              }
              if (e.kind === 'output') {
                // output connectors run the chat's bottom circle → the note's
                // top square in the chat's accent, arrowhead on the note end.
                // Same renderer as context; only the handles differ.
                return {
                  id: e.id,
                  source: e.source,
                  target: e.target,
                  sourceHandle: OUTPUT_HANDLE_ID,
                  targetHandle: INPUT_HANDLE_ID,
                  type: 'context',
                  style: { stroke: accent, strokeWidth: 3 },
                  markerEnd: {
                    type: MarkerType.ArrowClosed,
                    color: accent,
                    width: 14,
                    height: 14
                  },
                  focusable: false,
                  selectable: false
                }
              }
              if (e.kind === 'derive') {
                // derive connectors run source's right edge → note's left edge
                // in the source's accent, arrowhead marking the note it made
                return {
                  id: e.id,
                  source: e.source,
                  target: e.target,
                  type: 'derive',
                  style: { stroke: accent, strokeWidth: 3 },
                  markerEnd: {
                    type: MarkerType.ArrowClosed,
                    color: accent,
                    width: 14,
                    height: 14
                  },
                  focusable: false,
                  selectable: false
                }
              }
              return {
                id: e.id,
                source: e.source,
                target: e.target,
                type: 'fork',
                data: { sourceMessageId: e.sourceMessageId },
                // fork connectors take the parent chat's accent color;
                // researcher connectors are dashed to read as ephemeral spawns
                style: {
                  stroke: accent,
                  strokeWidth: 3,
                  ...(nodes.find((n) => n.id === e.target)?.data.kind === 'research'
                    ? { strokeDasharray: '6 4' }
                    : {})
                },
                focusable: false,
                selectable: false
              }
            })}
            onNodesChange={onNodesChange}
            onConnect={handleConnect}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            // connecting is opt-in per handle: only the ctx circles are live
            // (the hidden fork anchors stay isConnectable={false})
            connectionRadius={60}
            connectionLineStyle={{ stroke: '#C9A227', strokeWidth: 3, strokeDasharray: '6 4' }}
            // tap-to-connect is ours (ContextConnectOverlay), not React Flow's
            connectOnClick={false}
            minZoom={0.05}
            // deep enough to read a PDF page's body text; PdfViewer
            // re-rasterizes pages at the settled zoom so they stay crisp
            maxZoom={4}
            panOnScroll
            zoomOnPinch
            zoomOnDoubleClick={false}
            deleteKeyCode={null}
            onMoveEnd={(_, vp) => setStoreViewport(vp)}
            onDoubleClick={handleDoubleClick}
          >
            <Background variant={BackgroundVariant.Dots} gap={44} size={2.5} color="#CFC49F" />
            <ContextConnectOverlay />
          </ReactFlow>
        )}

        {loaded && (
          <div className="absolute bottom-4 left-4 z-10 flex items-end gap-2">
            {/* hidden (not unmounted) in split screen so Recent keeps its state */}
            <div className={split ? 'hidden' : 'contents'}>{folder?.current && <Sidebar />}</div>
            <AuthKeyButton />
            <SettingsButton />
          </div>
        )}

        {loaded && <PlacementOverlay />}

        {/* Corner legends replace the old app header. z-20 keeps them above
            the placement layer (z-10), so an armed spawn button can still be
            clicked to disarm — same as when the header sat over the canvas. */}
        {loaded && folder?.current && (
          <div className={`absolute top-4 left-4 z-20 ${split ? 'hidden' : ''}`}>
            <ActionsLegend />
          </div>
        )}
        {/* Model + Folder pickers sit under the docked panel — hide in split screen */}
        <div
          className={`absolute top-4 right-4 z-20 flex items-center gap-2 ${split ? 'hidden' : ''}`}
        >
          {loaded && folder?.current && <EffortSelector />}
          {loaded && folder?.current && <ModelSelector />}
          <FolderChip />
        </div>

        {folder && !folder.current && (
          <div className="flex h-full w-full flex-col items-center justify-center gap-4">
            <BeeIcon className="h-16 w-16" />
            <p className="text-[15px] text-[#92690B]">Pick a folder to start a canvas</p>
            <button
              type="button"
              onClick={() => void handleChooseFolder()}
              className="cursor-pointer rounded-[14px] border border-[#EDD27E] bg-[#FEF3C7] px-4 py-2 text-[14px] font-medium text-[#92690B] shadow-lg transition-colors hover:bg-[#FDE68A] active:scale-95"
            >
              Open folder…
            </button>
          </div>
        )}

        <DeleteChatModal />
      </div>

      {/* the right-docked reading panel — the canvas shrinks beside it */}
      <ExpandedPanel />
    </div>
  )
}

export default function Canvas(): React.JSX.Element {
  return (
    <ReactFlowProvider>
      <CanvasInner />
    </ReactFlowProvider>
  )
}
