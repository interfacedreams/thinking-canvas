import { useCallback, useEffect } from 'react'
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
import ForkEdge from './ForkEdge'
import ContextEdge from './ContextEdge'
import ContextConnectOverlay from './ContextConnectOverlay'
import BeeIcon from './BeeIcon'
import TopBar from './TopBar'
import Sidebar from './Sidebar'
import PlacementOverlay from './PlacementOverlay'
import DeleteChatModal from './DeleteChatModal'
import { useCanvasStore, NODE_W } from '../store/canvas'
import type { ChosenFile } from '../../../shared/types'
import { CTX_HANDLE_ID } from '../lib/nodeChrome'
import { paletteFor } from '../lib/palette'
import { useSpawn } from '../lib/useSpawn'

const nodeTypes: NodeTypes = { chat: ChatNodeView, note: NoteNodeView, file: FileNodeView }
const edgeTypes: EdgeTypes = { fork: ForkEdge, context: ContextEdge }

function CanvasInner(): React.JSX.Element {
  const nodes = useCanvasStore((s) => s.nodes)
  const storeEdges = useCanvasStore((s) => s.edges)
  const loaded = useCanvasStore((s) => s.loaded)
  const folder = useCanvasStore((s) => s.folder)
  const onNodesChange = useCanvasStore((s) => s.onNodesChange)
  const addContextEdge = useCanvasStore((s) => s.addContextEdge)
  const addNodeAt = useCanvasStore((s) => s.addNodeAt)
  const addNoteAt = useCanvasStore((s) => s.addNoteAt)
  const addDroppedFiles = useCanvasStore((s) => s.addDroppedFiles)
  const setStoreViewport = useCanvasStore((s) => s.setViewport)
  const init = useCanvasStore((s) => s.init)
  const chooseFolder = useCanvasStore((s) => s.chooseFolder)
  const { setViewport, fitView, screenToFlowPosition } = useReactFlow()
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
      // Bare C / N / F spawn a chat / note / file — but only when typing focus
      // is elsewhere, so the letters still work inside inputs and notes.
      if (e.altKey || e.repeat) return
      const t = e.target as HTMLElement
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable) return
      const key = e.key.toLowerCase()
      if (key === 'c' || key === 'n' || key === 'f') {
        e.preventDefault()
        spawn(key === 'n' ? 'note' : key === 'f' ? 'file' : 'chat')
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [fitView, spawn])

  // Releasing a connection drag on (or near — connectionRadius snaps) a
  // chat's circle commits the note/image → chat context link. Only note and
  // image circles can start a drag and only chat circles can end one, so
  // source/target here are already the right kinds; the store re-validates.
  const handleConnect = useCallback(
    (conn: Connection) => {
      addContextEdge(conn.source, conn.target)
      // a drag-connect landing mid click-to-connect supersedes it
      useCanvasStore.getState().setCtxConnectSource(null)
    },
    [addContextEdge]
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
  // (a note with alt/option held).
  const handleDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      if (!(e.target as HTMLElement).classList.contains('react-flow__pane')) return
      const p = screenToFlowPosition({ x: e.clientX, y: e.clientY })
      const position = { x: p.x - NODE_W / 2, y: p.y - 24 }
      if (e.altKey) addNoteAt(position)
      else addNodeAt(position)
    },
    [addNodeAt, addNoteAt, screenToFlowPosition]
  )

  return (
    <div className="flex h-screen w-screen flex-col bg-[#FBFAF4]">
      <TopBar />

      <div className="relative min-h-0 flex-1" onDragOver={handleDragOver} onDrop={handleDrop}>
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

        {loaded && folder?.current && <Sidebar />}

        {loaded && <PlacementOverlay />}

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
