import { app, ipcMain } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'
import { DEFAULT_PERMISSION_SETTINGS } from '../shared/types'
import type { PermissionSettings } from '../shared/types'

// --- Global permission settings -----------------------------------------
// App-wide auto-allow preferences, persisted in userData. Enforced inside
// canUseTool, so a change applies to the very next tool call — and any
// prompt already waiting on screen that the new settings cover is resolved
// on the spot (canUseTool's own permission-resolved emit dismisses it).

export const permissionsFile = (): string => join(app.getPath('userData'), 'permissions.json')

export let permissionSettings: PermissionSettings = { ...DEFAULT_PERMISSION_SETTINGS }

export async function readPermissionSettings(): Promise<PermissionSettings> {
  try {
    const raw = JSON.parse(await fs.readFile(permissionsFile(), 'utf8'))
    return {
      allowWebSearch: raw.allowWebSearch === true,
      autoAllowAll: raw.autoAllowAll === true
    }
  } catch {
    return { ...DEFAULT_PERMISSION_SETTINGS }
  }
}

export function autoAllowed(toolName: string): boolean {
  if (permissionSettings.autoAllowAll) return true
  return permissionSettings.allowWebSearch && (toolName === 'WebSearch' || toolName === 'WebFetch')
}

// Permission requests in flight: requestId → the tool asked about and the
// resolver for the user's verdict. canUseTool blocks the SDK turn until the
// renderer answers via thread:permission (or a settings change covers it).
export const pendingPermissions = new Map<
  string,
  { toolName: string; resolve: (allow: boolean) => void }
>()

export function registerPermissionSettingsIpc(): void {
  ipcMain.handle('settings:permissions:get', (): PermissionSettings => permissionSettings)

  ipcMain.handle(
    'settings:permissions:set',
    async (_event, patch: Partial<PermissionSettings>): Promise<PermissionSettings> => {
      permissionSettings = {
        allowWebSearch: patch.allowWebSearch ?? permissionSettings.allowWebSearch,
        autoAllowAll: patch.autoAllowAll ?? permissionSettings.autoAllowAll
      }
      await fs.writeFile(permissionsFile(), JSON.stringify(permissionSettings, null, 2))
      // Settle any prompt the new settings already answer.
      for (const { toolName, resolve } of pendingPermissions.values()) {
        if (autoAllowed(toolName)) resolve(true)
      }
      return permissionSettings
    }
  )
}
export async function initPermissionSettings(): Promise<void> {
  permissionSettings = await readPermissionSettings()
}
