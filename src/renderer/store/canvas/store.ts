import { create } from 'zustand'
import type { CanvasState } from './state'
import { createStoreHelpers } from './helpers'
import { loadEffort, loadModel } from './prefs'
import { createChatSlice } from './chatSlice'
import { createFoldersSlice } from './foldersSlice'
import { createMemorySlice } from './memorySlice'
import { createNodesSlice } from './nodesSlice'
import { createNotesSlice } from './notesSlice'
import { createViewSlice } from './viewSlice'

export const useCanvasStore = create<CanvasState>((set, get) => {
  const ctx = createStoreHelpers(set, get)
  return {
    nodes: [],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
    loaded: false,
    folder: null,
    model: loadModel(),
    effort: loadEffort(),
    anchorOffsets: {},
    pendingDeleteId: null,
    placing: null,
    placingContextSource: null,
    pendingFile: null,
    ctxConnectSource: null,
    shiftPicks: [],
    shiftHeld: false,
    transforming: null,
    expanded: null,

    ...createViewSlice(ctx),
    ...createFoldersSlice(ctx),
    ...createNodesSlice(ctx),
    ...createNotesSlice(ctx),
    ...createMemorySlice(ctx),
    ...createChatSlice(ctx)
  }
})
