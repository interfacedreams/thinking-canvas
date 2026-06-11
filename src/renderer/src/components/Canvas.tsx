import { useCallback, useEffect } from 'react'
import {
  Background,
  BackgroundVariant,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type EdgeTypes,
  type NodeTypes
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import ChatNodeView from './ChatNodeView'
import NoteNodeView from './NoteNodeView'
import ForkEdge from './ForkEdge'
import BeeIcon from './BeeIcon'
import TopBar from './TopBar'
import PlacementOverlay from './PlacementOverlay'
import DeleteChatModal from './DeleteChatModal'
import { useCanvasStore, NODE_W } from '../store/canvas'
import { paletteFor } from '../lib/palette'
import { useSpawn } from '../lib/useSpawn'

const nodeTypes: NodeTypes = { chat: ChatNodeView, note: NoteNodeView }
const edgeTypes: EdgeTypes = { fork: ForkEdge }

function CanvasInner(): React.JSX.Element {
  const nodes = useCanvasStore((s) => s.nodes)
  const storeEdges = useCanvasStore((s) => s.edges)
  const loaded = useCanvasStore((s) => s.loaded)
  const folder = useCanvasStore((s) => s.folder)
  const onNodesChange = useCanvasStore((s) => s.onNodesChange)
  const addNodeAt = useCanvasStore((s) => s.addNodeAt)
  const addNoteAt = useCanvasStore((s) => s.addNoteAt)
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
      // Bare C / N spawn a chat / note — but only when typing focus is
      // elsewhere, so the letters still work inside inputs and notes.
      if (e.altKey || e.repeat) return
      const t = e.target as HTMLElement
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable) return
      const key = e.key.toLowerCase()
      if (key === 'c' || key === 'n') {
        e.preventDefault()
        spawn(key === 'n' ? 'note' : 'chat')
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [fitView, spawn])

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

      <div className="relative min-h-0 flex-1">
        {loaded && (
          <ReactFlow
            nodes={nodes}
            edges={storeEdges.map((e) => ({
              id: e.id,
              source: e.source,
              target: e.target,
              type: 'fork',
              data: { sourceMessageId: e.sourceMessageId },
              // fork connectors take the parent chat's accent color;
              // researcher connectors are dashed to read as ephemeral spawns
              style: {
                stroke: paletteFor(nodes.find((n) => n.id === e.source)?.data.color).accent,
                strokeWidth: 3,
                ...(nodes.find((n) => n.id === e.target)?.data.kind === 'research'
                  ? { strokeDasharray: '6 4' }
                  : {})
              },
              focusable: false,
              selectable: false
            }))}
            onNodesChange={onNodesChange}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            nodesConnectable={false}
            minZoom={0.05}
            maxZoom={2}
            panOnScroll
            zoomOnPinch
            zoomOnDoubleClick={false}
            deleteKeyCode={null}
            onMoveEnd={(_, vp) => setStoreViewport(vp)}
            onDoubleClick={handleDoubleClick}
          >
            <Background variant={BackgroundVariant.Dots} gap={24} size={1.5} color="#E2DAC0" />
          </ReactFlow>
        )}

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
