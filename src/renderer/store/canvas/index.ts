// The canvas store, split into slices. Everything the old single-file module
// exported is re-exported here, so '@renderer/store/canvas' resolves the same.
export * from './model'
export type { CanvasState } from './state'
export { useCanvasStore } from './store'
import './events' // registers the thread-event listener (side effect)
