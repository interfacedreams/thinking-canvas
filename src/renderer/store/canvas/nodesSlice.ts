import {
  GAP,
  LINK_FRAME,
  NODE_W,
  fileFrame,
  forkSubtree,
  hostTitle,
  isChat,
  isFile,
  isLink,
  isNote,
  makeLabelNode,
  makeLinkNode,
  measureImage
} from './model'
import type { CanvasNode, PendingFile } from './model'
import type { CanvasState } from './state'
import type { StoreCtx } from './helpers'

export function createNodesSlice(
  ctx: StoreCtx
): Pick<
  CanvasState,
  | 'requestDelete'
  | 'cancelDelete'
  | 'deleteChat'
  | 'addNodeAt'
  | 'addNoteAt'
  | 'addFileAt'
  | 'addLabelAt'
  | 'addLinkAt'
  | 'openLinkInPanel'
  | 'setLinkUrl'
  | 'syncTabUrl'
  | 'addDroppedFiles'
  | 'clearFocusDraft'
  | 'setDraft'
  | 'setColor'
  | 'setTitle'
  | 'discardNode'
> {
  const {
    set,
    get,
    patchData,
    persist,
    persistNow,
    isClaudeMd,
    adopt,
    nextColor,
    spawnNode,
    spawnNote,
    placeFile
  } = ctx
  return {
    requestDelete: (id) => {
      if (isClaudeMd(id)) return // CLAUDE.md is permanent
      set({ pendingDeleteId: id })
    },

    cancelDelete: () => set({ pendingDeleteId: null }),

    deleteChat: (id, cascade) => {
      const byId = new Map(get().nodes.map((n) => [n.id, n]))
      const doomed = cascade ? forkSubtree(get().edges, id) : new Set([id])
      set((s) => ({
        pendingDeleteId: null,
        // deleting the panel-open node closes the panel with it
        ...(s.expanded && doomed.has(s.expanded.id) ? { expanded: null } : {}),
        nodes: s.nodes.filter((n) => !doomed.has(n.id)),
        edges: s.edges.filter((e) => !doomed.has(e.source) && !doomed.has(e.target))
      }))
      for (const nodeId of doomed) {
        const node = byId.get(nodeId)
        if (node && isNote(node)) void window.api.note.delete(nodeId)
        else if (node && isLink(node))
          void window.api.link.unclip(nodeId) // drop its clip, if any
        else if (node && isFile(node)) {
          // Delete the backing file too, so the top-level scan can't re-surface
          // the card on the next load. (Auto-placed cards derive their id from
          // the filename, so a card that's gone but a file that isn't comes back.)
          if (node.data.file) void window.api.file.delete(node.data.file)
        } else {
          void window.api.canvas.deleteThread(nodeId)
          // A pinned chat left a transcript clip behind — drop it too.
          if (node && isChat(node) && node.data.pinned) void window.api.chat.unclipMemory(nodeId)
        }
      }
      // Write the layout immediately rather than through the 500ms debounce, so
      // a quick close/reopen after a delete can't drop the save.
      persistNow()
    },

    addNodeAt: (position) => spawnNode(position),

    addNoteAt: (position) => spawnNote(position),

    addFileAt: (position) => {
      const pf = get().pendingFile
      if (!pf) return null
      const node = placeFile(position, pf)
      set({ pendingFile: null })
      return node
    },

    // Labels are born in edit mode (focusDraft) so you can type right away.
    addLabelAt: (position) => adopt(makeLabelNode(position, { focusDraft: true })),

    addLinkAt: (position, url) => {
      const node = makeLinkNode(position, {
        color: nextColor(),
        updatedAt: Date.now(),
        ...(url ? { url, title: hostTitle(url) } : {})
      })
      if (url) node.height = LINK_FRAME.height
      return adopt(node)
    },

    openLinkInPanel: (url, sourceId) => {
      // Drop the tab just right of the node the link was clicked in (so its
      // canvas card has a sensible home), or at the viewport's top-left when
      // there's no source.
      const src = sourceId ? get().nodes.find((n) => n.id === sourceId) : undefined
      const vp = get().viewport
      const position = src
        ? { x: src.position.x + (src.width ?? NODE_W) + GAP, y: src.position.y }
        : { x: (-vp.x + 80) / vp.zoom, y: (-vp.y + 80) / vp.zoom }
      const node = get().addLinkAt(position, url)
      // One tab at a time in the panel — the fresh tab replaces whatever was open.
      set({ expanded: { id: node.id, mode: 'panel' } })
      return node.id
    },

    setLinkUrl: (id, url) => {
      const node = get().nodes.find((n) => n.id === id)
      if (!node || !isLink(node)) return
      const title = node.data.title || hostTitle(url)
      // The committed page opens at the full browser-card height.
      set((s) => ({
        nodes: s.nodes.map((n) =>
          n.id === id
            ? ({
                ...n,
                height: Math.max(n.height ?? 0, LINK_FRAME.height),
                data: { ...n.data, url, title }
              } as CanvasNode)
            : n
        )
      }))
      persist()
    },

    // A result click, an address-bar search, a redirect — keep data.url on
    // the page actually showing (it's what a context edge hands to a chat,
    // and where the tab reopens on canvas load). An auto host title follows
    // the page along; a user-typed title stays put.
    syncTabUrl: (id, url) => {
      const node = get().nodes.find((n) => n.id === id)
      if (!node || !isLink(node) || !url || node.data.url === url) return
      const auto = !node.data.title || node.data.title === hostTitle(node.data.url ?? '')
      const title = auto ? hostTitle(url) || node.data.title : node.data.title
      set((s) => ({
        nodes: s.nodes.map((n) =>
          n.id === id ? ({ ...n, data: { ...n.data, url, title } } as CanvasNode) : n
        )
      }))
      persist()
    },

    addDroppedFiles: async (point, picked) => {
      let offset = 0
      for (const chosen of picked) {
        const pf: PendingFile = { ...chosen }
        if (pf.dataUrl) {
          // The node's frame comes from the image's natural size.
          const dims = await measureImage(pf.dataUrl)
          if (!dims || dims.w === 0 || dims.h === 0) continue
          pf.naturalWidth = dims.w
          pf.naturalHeight = dims.h
        }
        const { width } = fileFrame(pf)
        placeFile({ x: point.x - width / 2 + offset, y: point.y + offset }, pf)
        offset += 48
      }
    },

    clearFocusDraft: (id) => patchData(id, { focusDraft: undefined }),

    setDraft: (id, draft) => patchData(id, { draft }),

    setColor: (id, color) => {
      patchData(id, { color })
      persist()
    },

    setTitle: (id, title) => {
      patchData(id, { title })
      persist()
    },

    discardNode: (id) => {
      if (isClaudeMd(id)) return // permanent — never discarded as a blank note
      const node = get().nodes.find((n) => n.id === id)
      set((s) => ({
        ...(s.expanded?.id === id ? { expanded: null } : {}),
        nodes: s.nodes.filter((n) => n.id !== id),
        edges: s.edges.filter((e) => e.source !== id && e.target !== id)
      }))
      if (node && isNote(node)) void window.api.note.delete(id)
      else if (node && (isFile(node) || isLink(node))) {
        // nothing on disk to clean up
      } else void window.api.canvas.deleteThread(id)
      persist()
    }
  }
}
