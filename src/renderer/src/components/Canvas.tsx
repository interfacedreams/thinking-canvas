import { useCallback, useEffect, useMemo, useRef } from 'react'
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
import LabelNodeView from './LabelNodeView'
import ForkEdge from './ForkEdge'
import ContextEdge from './ContextEdge'
import DeriveEdge from './DeriveEdge'
import ContextConnectOverlay from './ContextConnectOverlay'
import EmptyFolderState from './EmptyFolderState'
import ActionsLegend from './ActionsLegend'
import MemoryLegend from './MemoryLegend'
import ModelSelector from './ModelSelector'
import EffortSelector from './EffortSelector'
import FolderChip from './FolderChip'
import Sidebar from './Sidebar'
import SettingsButton from './SettingsButton'
import PlacementOverlay from './PlacementOverlay'
import SelectionForkMenu from './SelectionForkMenu'
import DeleteChatModal from './DeleteChatModal'
import ExpandedPanel from './ExpandedPanel'
import Toast from './Toast'
import UpdateProgress from './UpdateProgress'
import { useToastStore } from '../store/toast'
import { useCanvasStore, NODE_W, isChat, isNote, isFile, isLink, isLabel } from '../store/canvas'
import type { ChosenFile } from '../../../shared/types'
import { CTX_HANDLE_ID, OUTPUT_HANDLE_ID, INPUT_HANDLE_ID } from '../lib/nodeChrome'
import { paletteFor } from '../lib/palette'
import { useSpawn } from '../lib/useSpawn'

const nodeTypes: NodeTypes = {
  chat: ChatNodeView,
  note: NoteNodeView,
  file: FileNodeView,
  link: LinkNodeView,
  label: LabelNodeView
}
const edgeTypes: EdgeTypes = { fork: ForkEdge, context: ContextEdge, derive: DeriveEdge }

// What the file picker / drop vetting actually accepts (mirrors FILE_MIME in
// the main process). Used only to phrase the rejection toast.
const SUPPORTED_DROP_EXT = ['png', 'jpg', 'jpeg', 'pdf']
const extOf = (name: string): string => name.slice(name.lastIndexOf('.') + 1).toLowerCase()

/** Toast copy for files the drop vetting refused — leads with the unsupported
 *  type (HEIC and friends) and points at what does work. */
function dropRejectMessage(rejected: File[]): string {
  const bad = rejected.map((f) => extOf(f.name)).filter((e) => e && !SUPPORTED_DROP_EXT.includes(e))
  const uniq = [...new Set(bad)]
  if (uniq.length === 1) {
    return `.${uniq[0].toUpperCase()} isn't supported — images must be PNG or JPEG.`
  }
  if (rejected.length === 1)
    return `Couldn't add “${rejected[0].name}” — images must be PNG or JPEG.`
  return `Couldn't add those files — images must be PNG or JPEG.`
}

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
  // Labels always float above every other resource. React Flow stacks by
  // node.zIndex (and adds 1000 to a selected node via elevateNodesOnSelect),
  // so labels get a base well above that ceiling while everything else keeps
  // its natural ordering.
  const layeredNodes = useMemo(
    () => nodes.map((n) => (isLabel(n) ? { ...n, zIndex: 10000 } : n)),
    [nodes]
  )
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
      // Bare C / N / F / T / L spawn a chat / note / file / tab / label — but
      // only when typing focus is elsewhere, so the letters still work inside
      // inputs and notes.
      if (e.altKey || e.repeat) return
      const t = e.target as HTMLElement
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable) return
      // Backspace / Delete removes the selected node(s) directly — no confirm
      // modal — except notes, which still pop the confirmation dialog since
      // their text isn't recoverable. Forks are left in place (cascade = false).
      if (e.key === 'Backspace' || e.key === 'Delete') {
        const s = useCanvasStore.getState()
        const selected = s.nodes.filter((n) => n.selected)
        if (selected.length > 0) {
          e.preventDefault()
          selected.forEach((n) => (isNote(n) ? s.requestDelete(n.id) : s.deleteChat(n.id, false)))
        }
        return
      }
      // While a click-to-connect is armed, the connect overlay owns C / N / F / T / L
      // — it drops the new node already wired to the source.
      if (useCanvasStore.getState().ctxConnectSource) return
      const key = e.key.toLowerCase()
      if (key === 'c' || key === 'n' || key === 'f' || key === 't' || key === 'l') {
        e.preventDefault()
        // Reading a file/link in the half-sheet, C means "chat about this":
        // arm a chat ghost that already trails a dimmed context edge from the
        // open resource — you still click to place it, and dropping wires the
        // edge. Full screen is single-doc reading, so it keeps the plain spawn.
        if (key === 'c') {
          const s = useCanvasStore.getState()
          const open =
            s.expanded?.mode === 'panel' ? s.nodes.find((n) => n.id === s.expanded?.id) : undefined
          if (open && (isFile(open) || isLink(open))) {
            s.armContextChat(open.id)
            return
          }
        }
        spawn(
          key === 'n'
            ? 'note'
            : key === 'f'
              ? 'file'
              : key === 't'
                ? 'link'
                : key === 'l'
                  ? 'label'
                  : 'chat'
        )
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

  // Shift+click multi-select doubles as connect: holding Shift and clicking two
  // nodes that form a valid source→target pair (in click order) draws the edge.
  // We hit-test the clicked `.react-flow__node` from a window listener rather
  // than React Flow's onNodeClick, because a click landing on a link's <webview>
  // guest never reaches the host DOM as an onNodeClick — but with Shift held,
  // LinkNodeView floats a transparent host-DOM layer over that guest, so the
  // click surfaces here and resolves to the node's data-id all the same. The
  // ordered tally and the pairing live in the store (shiftConnect); a click
  // without Shift, on a node or the bare pane, clears it so it can't go stale.
  useEffect(() => {
    const onClick = (e: MouseEvent): void => {
      const t = e.target as HTMLElement | null
      const s = useCanvasStore.getState()
      if (!e.shiftKey) {
        s.resetShiftConnect()
        return
      }
      // let interactive chrome (delete, pin, the address bar) act on its own —
      // a Shift-click there shouldn't also count as a connect pick
      if (t?.closest('button, a, input, textarea, [contenteditable="true"]')) return
      const id = t?.closest('.react-flow__node')?.getAttribute('data-id')
      if (id) s.shiftConnect(id)
    }
    // Track Shift so LinkNodeView can mount its over-the-webview pick layer only
    // while it's held; a window blur (focus left the app) drops the held state.
    const onShiftKey = (e: KeyboardEvent): void => {
      if (e.key === 'Shift') useCanvasStore.getState().setShiftHeld(e.type === 'keydown')
    }
    const onBlur = (): void => useCanvasStore.getState().setShiftHeld(false)
    // capture phase: runs before React Flow's own handlers, and we never stop
    // propagation, so native Shift multi-select keeps working underneath.
    window.addEventListener('click', onClick, true)
    window.addEventListener('keydown', onShiftKey)
    window.addEventListener('keyup', onShiftKey)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('click', onClick, true)
      window.removeEventListener('keydown', onShiftKey)
      window.removeEventListener('keyup', onShiftKey)
      window.removeEventListener('blur', onBlur)
    }
  }, [])

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
      // composers, titles, and notes keep their normal paste. The paste's
      // target can be a text node or a nested non-editable child (e.g. inside
      // TipTap), so check the focused element and walk up from the target
      // rather than trusting target's own tag/contentEditable.
      const isEditable = (n: EventTarget | null): boolean => {
        const el = n instanceof Element ? n : n instanceof Node ? n.parentElement : null
        return !!el?.closest('input, textarea, [contenteditable="true"]')
      }
      if (isEditable(document.activeElement) || isEditable(e.target)) return
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
        const results = await Promise.all(
          files.map(async (f) => {
            // '' for path-less files (e.g. an image dragged from a browser)
            const path = window.api.file.pathFor(f)
            return path ? await window.api.file.fromPath(path) : null
          })
        )
        const picked = results.filter((c): c is ChosenFile => c !== null)
        if (picked.length > 0) await addDroppedFiles({ x: p.x, y: p.y - 24 }, picked)
        // Anything the main process refused (HEIC and other unsupported types,
        // oversized PDFs, unreadable files) comes back null — surface it as a
        // swooping banner rather than swallowing the drop in silence.
        const rejected = files.filter((_, i) => results[i] === null)
        if (rejected.length > 0) useToastStore.getState().show(dropRejectMessage(rejected))
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
            nodes={layeredNodes}
            edges={storeEdges.map((e) => {
              const accent = paletteFor(nodes.find((n) => n.id === e.source)?.data.color).accent
              if (e.kind === 'context') {
                // context connectors run top circle → top circle in the
                // source's accent, arrowhead marking which way context flows.
                // A chat source has no top circle to emit from — it leaves from
                // its right knob (OUTPUT_HANDLE_ID), where it was pulled from.
                const srcNode = nodes.find((n) => n.id === e.source)
                const chatSource = !!srcNode && isChat(srcNode)
                return {
                  id: e.id,
                  source: e.source,
                  target: e.target,
                  sourceHandle: chatSource ? OUTPUT_HANDLE_ID : CTX_HANDLE_ID,
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
            <SettingsButton />
          </div>
        )}

        {loaded && <PlacementOverlay />}
        {loaded && <SelectionForkMenu />}

        {/* Corner legends replace the old app header. z-20 keeps them above
            the placement layer (z-10), so an armed spawn button can still be
            clicked to disarm — same as when the header sat over the canvas. */}
        {loaded && folder?.current && (
          <div
            className={`absolute top-4 left-4 z-20 flex flex-col gap-2 ${split ? 'hidden' : ''}`}
          >
            <ActionsLegend />
            <MemoryLegend />
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

        {folder && !folder.current && <EmptyFolderState />}

        <DeleteChatModal />
      </div>

      {/* the right-docked reading panel — the canvas shrinks beside it */}
      <ExpandedPanel />

      {/* swooping error banner (unsupported drops, etc.) */}
      <Toast />

      {/* download progress while an opted-in update is fetching */}
      <UpdateProgress />
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
