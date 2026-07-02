import { create } from 'zustand'

// A single transient toast — the swooping red banner that drops from the top
// when something can't be added (an unsupported image, an oversized PDF). One
// at a time: a new toast replaces whatever's showing. Kept outside the canvas
// store so any drop/paste path can raise one without touching canvas state.
export interface Toast {
  /** Bumps every show() so the banner remounts and replays its animation. */
  id: number
  message: string
}

interface ToastState {
  toast: Toast | null
  show: (message: string) => void
  clear: () => void
}

let counter = 0

export const useToastStore = create<ToastState>((set) => ({
  toast: null,
  show: (message) => set({ toast: { id: ++counter, message } }),
  clear: () => set({ toast: null })
}))
