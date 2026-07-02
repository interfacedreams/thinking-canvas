import { create } from 'zustand'
import type { McpConfig, McpProbeResult, PermissionSettings } from '@shared/types'

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
  /** App-wide MCP connector config; null until first loaded. */
  mcp: McpConfig | null
  /** The MCP load round-trip threw — typically a stale preload without the
   *  `window.api.mcp` bridge (added this session, needs an app restart). */
  mcpLoadFailed: boolean
  loadMcp: () => Promise<void>
  updateMcp: (patch: Partial<Pick<McpConfig, 'enabled' | 'json'>>) => Promise<void>
  /** Last connection-probe result; null until a probe has run. */
  mcpStatus: McpProbeResult | null
  /** A probe is in flight (servers shown as "connecting"). */
  mcpProbing: boolean
  probeMcp: () => Promise<void>
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
  },
  mcp: null,
  mcpLoadFailed: false,
  loadMcp: async () => {
    try {
      // A stale preload (pre-restart) won't have this bridge — treat its
      // absence as a load failure so the UI can prompt a restart.
      if (!window.api.mcp) throw new Error('MCP bridge unavailable — restart needed')
      set({ mcp: await window.api.mcp.get(), mcpLoadFailed: false })
    } catch (err) {
      console.error('Failed to load MCP config', err)
      set({ mcpLoadFailed: true })
    }
  },
  updateMcp: async (patch) => {
    // A config change invalidates any prior status — clear it so stale dots
    // don't linger next to edited servers.
    set({ mcp: await window.api.mcp.set(patch), mcpLoadFailed: false, mcpStatus: null })
  },
  mcpStatus: null,
  mcpProbing: false,
  probeMcp: async () => {
    set({ mcpProbing: true })
    try {
      set({ mcpStatus: await window.api.mcp.probe() })
    } catch (err) {
      console.error('MCP probe failed', err)
      set({ mcpStatus: { ok: false, servers: [], error: 'Probe failed — see console.' } })
    } finally {
      set({ mcpProbing: false })
    }
  }
}))
