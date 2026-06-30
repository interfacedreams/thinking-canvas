// Auto-update wiring. electron-updater checks GitHub Releases for a newer
// version (using the `publish` block in electron-builder.yml + the
// latest-mac.yml manifest uploaded alongside each release). We do NOT download
// automatically — when a newer version exists we ask first, and only fetch the
// (large) update if the user opts in. Signed + notarized builds install
// cleanly on restart.
import { app, dialog, BrowserWindow } from 'electron'
import electronUpdater from 'electron-updater'

const { autoUpdater } = electronUpdater

// Check at startup and then every few hours while the app stays open.
const CHECK_INTERVAL_MS = 1000 * 60 * 60 * 4

export function initAutoUpdater(): void {
  // Auto-update only makes sense for a packaged, signed app. In dev there is
  // no app-update.yml, so skip entirely to avoid noisy errors.
  if (!app.isPackaged) return

  // Ask before pulling the update; download only on the user's say-so. If they
  // download but don't restart, it still installs on the next quit.
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true

  // Guard against stacking dialogs if a check fires again while one is open.
  let prompting = false

  autoUpdater.on('error', (err) => {
    console.error('[updater] error:', err)
  })

  // A newer version exists — offer it. Downloads only if the user clicks.
  autoUpdater.on('update-available', (info) => {
    if (prompting) return
    prompting = true
    const win = BrowserWindow.getAllWindows()[0]
    dialog
      .showMessageBox(win, {
        type: 'info',
        buttons: ['Download', 'Not now'],
        defaultId: 0,
        cancelId: 1,
        message: `Version ${info.version} is available`,
        detail: 'Download it now? You can keep working while it downloads.'
      })
      .then(({ response }) => {
        prompting = false
        if (response === 0) void autoUpdater.downloadUpdate()
      })
      .catch(() => {
        prompting = false
      })
  })

  // Download finished — offer to restart into it.
  autoUpdater.on('update-downloaded', (info) => {
    const win = BrowserWindow.getAllWindows()[0]
    dialog
      .showMessageBox(win, {
        type: 'info',
        buttons: ['Restart now', 'Later'],
        defaultId: 0,
        cancelId: 1,
        message: `Version ${info.version} is ready`,
        detail: 'Restart thinking canvas to finish updating.'
      })
      .then(({ response }) => {
        if (response === 0) autoUpdater.quitAndInstall()
      })
      .catch(() => {})
  })

  void autoUpdater.checkForUpdates()
  setInterval(() => void autoUpdater.checkForUpdates(), CHECK_INTERVAL_MS)
}
