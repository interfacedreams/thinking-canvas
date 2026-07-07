import { app, BrowserWindow } from 'electron'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { initAutoUpdater } from './updater'
import { initAdblock, registerAdblockIpc } from './adblock'
import { initAuth, registerAuthIpc } from './auth'
import { registerCanvasIpc } from './canvas'
import { registerFileIpc } from './files'
import { initFolderRoot, migrateLegacyUserData, registerFolderIpc } from './folders'
import { registerNoteIpc } from './notes'
import { initPermissionSettings, registerPermissionSettingsIpc } from './permissions'
import { registerThreadIpc } from './thread'
import { registerWidgetIpc, registerWidgetProtocol, registerWidgetScheme } from './widgets'
import { createWindow, hardenWebContents, setupBrowsePermissions } from './window'

// Custom schemes must be declared before the app is ready.
registerWidgetScheme()

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(async () => {
  // Carry over state from the pre-rename (bee-claude) app data dir, if any.
  // Must run before anything reads userData (settings, auth, localStorage).
  await migrateLegacyUserData()

  // Set app user model id for windows
  electronApp.setAppUserModelId('com.electron')

  // In dev the Dock shows the default Electron icon; set ours explicitly.
  // (Packaged builds pick up build/icon.icns automatically.)
  if (process.platform === 'darwin' && app.dock) {
    app.dock.setIcon(icon)
  }

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  hardenWebContents()
  setupBrowsePermissions()

  // Decide auth before any SDK call: subscription token beats Settings API key
  // beats .env key.
  await initAuth()

  await initPermissionSettings()

  // Reopen the folder from last time if it still exists.
  await initFolderRoot()

  registerWidgetProtocol()
  registerCanvasIpc()
  registerNoteIpc()
  registerWidgetIpc()
  registerFileIpc()
  registerThreadIpc()
  registerFolderIpc()
  registerAuthIpc()
  registerPermissionSettingsIpc()
  registerAdblockIpc()

  createWindow()

  // Loads filter lists (cached after first run) and applies blocking to the
  // browse session — fired non-blocking so it never delays window creation.
  void initAdblock()

  // Check GitHub Releases for a newer version and self-update in the background.
  // No-op in dev (unpackaged); only runs in a real build.
  initAutoUpdater()

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
