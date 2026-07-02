import { applyNodeChanges } from '@xyflow/react'
import { isFile, isLink, isNote, measureImage } from './model'
import type { CanvasNode } from './model'
import type { CanvasState } from './state'
import type { StoreCtx } from './helpers'
import { EFFORT_STORAGE_KEY, MODEL_STORAGE_KEY } from './prefs'

export function createViewSlice(
  ctx: StoreCtx
): Pick<
  CanvasState,
  | 'setPlacing'
  | 'armContextChat'
  | 'startFilePlacement'
  | 'setCtxConnectSource'
  | 'shiftConnect'
  | 'resetShiftConnect'
  | 'setShiftHeld'
  | 'setTransforming'
  | 'setModel'
  | 'setEffort'
  | 'expandNode'
  | 'collapseExpanded'
  | 'setAnchorOffsets'
  | 'onNodesChange'
  | 'setViewport'
  | 'toggleMinimize'
> {
  const { set, get, persist } = ctx
  return {
    // The pending image lives and dies with file-placement mode. Any re-arm or
    // cancel also drops a pending context source — it only rides a C-armed chat.
    setPlacing: (kind) =>
      set(
        kind === 'file'
          ? { placing: kind, placingContextSource: null }
          : { placing: kind, pendingFile: null, placingContextSource: null }
      ),

    // "Chat about this": arm a chat ghost that carries a dimmed pending context
    // edge from the resource (the note/file/link's right knob, or C while
    // reading a file/link in the half-sheet). Re-arming the same source disarms
    // (toggle), matching the toolbar buttons.
    armContextChat: (sourceId) => {
      const s = get()
      const src = s.nodes.find((n) => n.id === sourceId)
      if (!src || !(isFile(src) || isLink(src) || isNote(src))) return
      if (s.placing === 'chat' && s.placingContextSource === sourceId) {
        set({ placing: null, placingContextSource: null })
        return
      }
      set({ placing: 'chat', pendingFile: null, placingContextSource: sourceId })
    },

    startFilePlacement: async () => {
      const picked = await window.api.file.choose()
      if (!picked) return
      // PDFs place as a fixed card — nothing to measure.
      if (picked.kind === 'pdf' || !picked.dataUrl) {
        set({ placing: 'file', pendingFile: picked })
        return
      }
      // Measure the image before placing — the node's frame comes from it.
      const dims = await measureImage(picked.dataUrl)
      if (!dims || dims.w === 0 || dims.h === 0) return
      set({
        placing: 'file',
        pendingFile: { ...picked, naturalWidth: dims.w, naturalHeight: dims.h }
      })
    },

    setCtxConnectSource: (id) => set({ ctxConnectSource: id }),

    shiftConnect: (id) => {
      const picks = get().shiftPicks
      // a second click on the same node toggles it back off (mirrors React
      // Flow deselecting it), so a mis-click is easy to undo
      if (picks.includes(id)) {
        set({ shiftPicks: picks.filter((x) => x !== id) })
        return
      }
      const next = [...picks, id]
      if (next.length < 2) {
        set({ shiftPicks: next }) // first pick — wait for the partner
        return
      }
      // Second pick: clear the tally and connect the pair. Connections are
      // undirected, so click order doesn't matter; addContextEdge re-validates
      // (at least one non-research chat in the pair) and no-ops on a bad or
      // duplicate pair — `connected` reads whether a wire actually landed.
      set({ shiftPicks: [] })
      const [aId, bId] = next
      const before = get().edges.length
      get().addContextEdge(aId, bId)
      const connected = get().edges.length > before
      // A wired pair drops the selection it left behind; a non-pair stays
      // multi-selected (React Flow's own shift-select) so it can drag together.
      if (connected)
        set((s) => ({
          nodes: s.nodes.map((n) =>
            (n.id === aId || n.id === bId) && n.selected ? { ...n, selected: false } : n
          )
        }))
    },

    resetShiftConnect: () => {
      if (get().shiftPicks.length) set({ shiftPicks: [] })
    },

    setShiftHeld: (held) => {
      if (get().shiftHeld !== held) set({ shiftHeld: held })
    },

    setTransforming: (id) =>
      set((s) => ({
        transforming: id,
        // Arming transform: deselect the inner node so it sheds its focus ring
        // and the dashed frame stands on its own.
        nodes:
          id == null
            ? s.nodes
            : s.nodes.map((n) => (n.id === id && n.selected ? { ...n, selected: false } : n))
      })),

    setModel: (model) => {
      set({ model })
      localStorage.setItem(MODEL_STORAGE_KEY, model)
    },

    setEffort: (effort) => {
      set({ effort })
      localStorage.setItem(EFFORT_STORAGE_KEY, effort)
    },

    expandNode: (id, mode = 'panel') => {
      if (!get().nodes.some((n) => n.id === id)) return
      set({ expanded: { id, mode } })
    },

    collapseExpanded: () => set({ expanded: null }),

    setAnchorOffsets: (nodeId, offsets) => {
      set((s) => {
        const prev = s.anchorOffsets[nodeId]
        const unchanged =
          prev &&
          Object.keys(prev).length === Object.keys(offsets).length &&
          Object.entries(offsets).every(([k, v]) => prev[k] === v)
        if (unchanged) return {}
        return { anchorOffsets: { ...s.anchorOffsets, [nodeId]: offsets } }
      })
    },

    onNodesChange: (changes) => {
      set((s) => ({ nodes: applyNodeChanges(changes, s.nodes) }))
      persist()
    },

    setViewport: (viewport) => {
      set({ viewport })
      persist()
    },

    toggleMinimize: (id) => {
      set((s) => ({
        nodes: s.nodes.map((n) => {
          if (n.id !== id) return n
          if (n.data.minimized) {
            // expand: restore the explicit height if there was one
            return {
              ...n,
              height: n.data.savedHeight,
              data: { ...n.data, minimized: false, savedHeight: undefined }
            } as CanvasNode
          }
          // minimize: drop the explicit height so the node collapses to the title row
          return {
            ...n,
            height: undefined,
            data: { ...n.data, minimized: true, savedHeight: n.height }
          } as CanvasNode
        })
      }))
      persist()
    }
  }
}
