import { create } from 'zustand'
import type { PermissionSettings } from '@shared/types'

// Global settings modal state + the app-wide permission preferences behind
// it. Kept outside the canvas store so a permission prompt inside any chat
// node can pop the modal open without touching canvas state.
interface SettingsState {
  modalOpen: boolean
  setModalOpen: (open: boolean) => void
  /** null until the first load round-trip completes. */
  permissions: PermissionSettings | null
  /** The load round-trip threw (e.g. a stale preload without the settings
   *  bridge) — surfaced in the modal instead of an eternal "Loading…". */
  loadFailed: boolean
  load: () => Promise<void>
  update: (patch: Partial<PermissionSettings>) => Promise<void>
}

export const useSettingsStore = create<SettingsState>((set) => ({
  modalOpen: false,
  setModalOpen: (open) => set({ modalOpen: open }),
  permissions: null,
  loadFailed: false,
  load: async () => {
    try {
      set({ permissions: await window.api.settings.permissions(), loadFailed: false })
    } catch (err) {
      console.error('Failed to load permission settings', err)
      set({ loadFailed: true })
    }
  },
  update: async (patch) => {
    set({ permissions: await window.api.settings.setPermissions(patch) })
  }
}))
