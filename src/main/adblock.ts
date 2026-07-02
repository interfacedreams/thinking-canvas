import { app, ipcMain, session } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'
import { ElectronBlocker, adsAndTrackingLists } from '@ghostery/adblocker-electron'
import { BROWSE_PARTITION } from '../shared/types'

// --- Ad blocking ----------------------------------------------------------
// Network-level ad/tracker blocking (the EasyList family) on the shared
// browse partition, so every tab guest gets it. Cosmetic filtering stays off
// on purpose: it would register a preload in the guests, and the
// will-attach-webview hardening wants guests preload-free — network blocking
// alone catches the bulk anyway. The compiled engine caches to userData, so
// only the first launch (or a list refresh) hits the network.

export const adblockSettingsFile = (): string => join(app.getPath('userData'), 'adblock.json')

export let adblockEnabled = true
export let adblockEngine: ElectronBlocker | null = null

export async function readAdblockEnabled(): Promise<boolean> {
  try {
    // on by default — only an explicit { enabled: false } turns it off
    return JSON.parse(await fs.readFile(adblockSettingsFile(), 'utf8')).enabled !== false
  } catch {
    return true
  }
}

export function applyAdblock(): void {
  if (!adblockEngine) return
  const browse = session.fromPartition(BROWSE_PARTITION)
  if (adblockEnabled) {
    adblockEngine.enableBlockingInSession(browse) // idempotent
  } else if (adblockEngine.isBlockingEnabled(browse)) {
    adblockEngine.disableBlockingInSession(browse)
  }
}

export async function initAdblock(): Promise<void> {
  adblockEnabled = await readAdblockEnabled()
  try {
    adblockEngine = await ElectronBlocker.fromLists(
      fetch,
      adsAndTrackingLists,
      { loadCosmeticFilters: false, enableCompression: true },
      {
        path: join(app.getPath('userData'), 'adblock-engine.bin'),
        read: fs.readFile,
        write: fs.writeFile
      }
    )
    applyAdblock()
  } catch (err) {
    // offline with a cold cache — tabs just browse unblocked this launch
    console.error('adblock: failed to load filter lists', err)
  }
}

export function registerAdblockIpc(): void {
  ipcMain.handle('adblock:get', (): boolean => adblockEnabled)

  ipcMain.handle('adblock:set', async (_event, enabled: boolean): Promise<boolean> => {
    adblockEnabled = enabled === true
    applyAdblock()
    await fs.writeFile(adblockSettingsFile(), JSON.stringify({ enabled: adblockEnabled }, null, 2))
    return adblockEnabled
  })
}
