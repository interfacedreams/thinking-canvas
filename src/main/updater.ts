// Auto-update wiring. electron-updater checks GitHub Releases for a newer
// version (using the `publish` block in electron-builder.yml + the
// latest-mac.yml manifest uploaded alongside each release), downloads it in
// the background, and installs on quit. Signed + notarized builds update
// silently; users just relaunch into the new version.
import { app, dialog, BrowserWindow } from 'electron'
import electronUpdater from 'electron-updater'

const { autoUpdater } = electronUpdater

// Check at startup and then every few hours while the app stays open.
const CHECK_INTERVAL_MS = 1000 * 60 * 60 * 4

export function initAutoUpdater(): void {
  // Auto-update only makes sense for a packaged, signed app. In dev there is
  // no app-update.yml, so skip entirely to avoid noisy errors.
  if (!app.isPackaged) return

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('error', (err) => {
    console.error('[updater] error:', err)
  })

  autoUpdater.on('update-downloaded', (info) => {
    const win = BrowserWindow.getAllWindows()[0]
    const prompt = dialog.showMessageBox(win, {
      type: 'info',
      buttons: ['Restart now', 'Later'],
      defaultId: 0,
      cancelId: 1,
      message: `Version ${info.version} is ready`,
      detail: 'Restart thinking canvas to finish updating.'
    })
    prompt
      .then(({ response }) => {
        if (response === 0) autoUpdater.quitAndInstall()
      })
      .catch(() => {})
  })

  void autoUpdater.checkForUpdates()
  setInterval(() => void autoUpdater.checkForUpdates(), CHECK_INTERVAL_MS)
}
