import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { promises as fs } from 'fs'
import { basename, join } from 'path'
import type { CanvasDoc, FolderState } from '../shared/types'
import { canvasFileFor, dirExists, getFolderRoot, sanitizeTitle, setFolderRoot } from './paths'
import { noteFiles, noteSync, stopNoteWatcher } from './notes'

export interface FolderSettings {
  current: string | null
  recents: string[]
  lastCreateParent?: string // sticky parent for "New Folder"; defaults to ~/Documents/Thinking Canvas
}

// Where new folders land by default — a visible, user-owned spot (Finder, backups)
// rather than the hidden userData dir. The parent becomes sticky after the first create.
// Existing folders are referenced by absolute path in folders.json, so renaming this
// default only affects *new* creates — work already under ~/Documents/Bee Claude stays put.
export const defaultCreateParent = (): string => join(app.getPath('documents'), 'Thinking Canvas')

export const settingsFile = (): string => join(app.getPath('userData'), 'folders.json')
// Pre-rename installs kept their state in repos.json — read it as a fallback.
export const legacySettingsFile = (): string => join(app.getPath('userData'), 'repos.json')

// The app was renamed bee-claude → thinking-canvas. Electron derives userData
// from the app name, so the rename points us at a fresh, empty directory while
// all prior state (token, folders.json, permissions, localStorage) still sits
// under the old name. On first launch into the new dir, copy the old one over.
// Idempotent: skips once the new dir holds our settings, so it runs at most once.
export async function migrateLegacyUserData(): Promise<void> {
  const current = app.getPath('userData')
  const exists = async (p: string): Promise<boolean> =>
    fs.access(p).then(
      () => true,
      () => false
    )
  // Already initialized in the new location — nothing to carry over.
  if ((await exists(settingsFile())) || (await exists(legacySettingsFile()))) return

  const appData = app.getPath('appData')
  // Dev runs key off package.json "name" ("bee-claude"); packaged builds off
  // productName ("bee claude"). Try both old homes.
  for (const legacyName of ['bee claude', 'bee-claude']) {
    const legacyDir = join(appData, legacyName)
    if (legacyDir === current) continue
    if (
      !(await exists(join(legacyDir, 'folders.json'))) &&
      !(await exists(join(legacyDir, 'repos.json')))
    )
      continue
    try {
      await fs.cp(legacyDir, current, { recursive: true })
      console.log(`Migrated app data from "${legacyName}" → thinking canvas`)
    } catch (err) {
      console.error('Legacy app-data migration failed:', err)
    }
    return
  }
}

export async function readSettings(): Promise<FolderSettings> {
  for (const file of [settingsFile(), legacySettingsFile()]) {
    try {
      return JSON.parse(await fs.readFile(file, 'utf8'))
    } catch {
      // missing or unreadable — try the next
    }
  }
  return { current: null, recents: [] }
}

export async function chatCountFor(root: string): Promise<number> {
  try {
    const doc: CanvasDoc = JSON.parse(await fs.readFile(canvasFileFor(root), 'utf8'))
    // A title marks a chat: it's stamped on the first send (and on fork).
    return doc.nodes.filter((n) => n.title).length
  } catch {
    return 0
  }
}

export async function buildFolderState(): Promise<FolderState> {
  const settings = await readSettings()
  const recents: FolderState['recents'] = []
  for (const path of settings.recents) {
    if (!(await dirExists(path))) continue
    const chatCount = await chatCountFor(path)
    // Only folders you actually chatted in earn a recents slot (plus the open one).
    if (chatCount > 0 || path === getFolderRoot()) {
      recents.push({ path, name: basename(path), chatCount })
    }
  }
  return {
    current: getFolderRoot(),
    recents,
    createParent: settings.lastCreateParent ?? defaultCreateParent()
  }
}

export async function setCurrentFolder(root: string): Promise<FolderState> {
  setFolderRoot(root)
  stopNoteWatcher() // restarted by the next canvas:load
  noteFiles.clear() // rebuilt by the next canvas:load
  noteSync.clear()
  const settings = await readSettings()
  settings.current = root
  settings.recents = [root, ...settings.recents.filter((r) => r !== root)].slice(0, 20)
  await fs.writeFile(settingsFile(), JSON.stringify(settings, null, 2))
  return buildFolderState()
}

export function registerFolderIpc(): void {
  ipcMain.handle('folder:get', () => buildFolderState())

  ipcMain.handle('folder:choose', async (event): Promise<FolderState | null> => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const options = {
      title: 'Choose a folder',
      properties: ['openDirectory' as const, 'createDirectory' as const]
    }
    const res = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options)
    if (res.canceled || res.filePaths.length === 0) return null
    return setCurrentFolder(res.filePaths[0])
  })

  ipcMain.handle('folder:select', async (_event, path: string): Promise<FolderState> => {
    if (await dirExists(path)) return setCurrentFolder(path)
    return buildFolderState() // gone from disk — the rebuilt state simply drops it
  })

  // Create a fresh folder under `parent` (defaulting to the sticky create parent),
  // remember that parent for next time, and open the new folder as the current one.
  ipcMain.handle(
    'folder:create',
    async (_event, name: string, parent?: string): Promise<FolderState | null> => {
      const dir = parent?.trim() || defaultCreateParent()
      await fs.mkdir(dir, { recursive: true })

      // First free name under `dir` — "Foo", "Foo 2", … — same scheme as note
      // titles (allocateNoteFile), checked against the filesystem so we never
      // clobber an existing folder.
      const base = sanitizeTitle(name) || 'Untitled'
      let target: string
      for (let n = 1; ; n++) {
        target = join(dir, n === 1 ? base : `${base} ${n}`)
        if (!(await dirExists(target))) break
      }
      await fs.mkdir(target)

      const settings = await readSettings()
      settings.lastCreateParent = dir
      await fs.writeFile(settingsFile(), JSON.stringify(settings, null, 2))
      return setCurrentFolder(target)
    }
  )

  // Let the user repoint where new folders get created (the picked dir sticks).
  ipcMain.handle('folder:pickCreateParent', async (event): Promise<string | null> => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const options = {
      title: 'Choose where new folders are created',
      properties: ['openDirectory' as const, 'createDirectory' as const]
    }
    const res = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options)
    if (res.canceled || res.filePaths.length === 0) return null
    const settings = await readSettings()
    settings.lastCreateParent = res.filePaths[0]
    await fs.writeFile(settingsFile(), JSON.stringify(settings, null, 2))
    return res.filePaths[0]
  })
}
/** Reopen the folder from last time if it still exists. */
export async function initFolderRoot(): Promise<void> {
  const settings = await readSettings()
  if (settings.current && (await dirExists(settings.current))) setFolderRoot(settings.current)
}
