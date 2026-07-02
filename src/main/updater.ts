// Auto-update wiring. electron-updater checks GitHub Releases for a newer
// version (using the `publish` block in electron-builder.yml + the
// latest-mac.yml manifest uploaded alongside each release). We do NOT download
// automatically — when a newer version exists we ask first, and only fetch the
// (large) update if the user opts in. Signed + notarized builds install
// cleanly on restart.
import { app, dialog, BrowserWindow } from 'electron'
import { spawn } from 'child_process'
import electronUpdater from 'electron-updater'
import log from 'electron-log'

const { autoUpdater } = electronUpdater

// The launchd label Squirrel.Mac registers its ShipIt install helper under:
// "<bundle id>.ShipIt" (bundle id = appId in electron-builder.yml).
const SHIPIT_JOB = 'com.thinkingcanvas.app.ShipIt'

// Check at startup and then every few hours while the app stays open.
const CHECK_INTERVAL_MS = 1000 * 60 * 60 * 4

export function initAutoUpdater(): void {
  // Auto-update only makes sense for a packaged, signed app. In dev there is
  // no app-update.yml, so skip entirely to avoid noisy errors.
  if (!app.isPackaged) return

  // Persistent updater log — packaged builds have no console, and every
  // install failure so far has been a black box. electron-log writes to
  // ~/Library/Logs/thinking-canvas/main.log, including Squirrel's own
  // messages, so a stranded install finally says why.
  log.transports.file.level = 'info'
  autoUpdater.logger = log

  // Ask before pulling the update; download only on the user's say-so. If they
  // download but don't restart, it still installs on the next quit.
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true

  // Guard against stacking dialogs if a check fires again while one is open.
  let prompting = false

  autoUpdater.on('error', (err) => {
    log.error('[updater] error:', err)
  })

  // Feed download progress to the Dock icon and the renderer's in-app pill so
  // the (opt-in) download doesn't feel like a silent hang.
  autoUpdater.on('download-progress', (p) => {
    const win = BrowserWindow.getAllWindows()[0]
    if (!win || win.isDestroyed()) return
    win.setProgressBar(p.percent / 100)
    win.webContents.send('update:progress', { percent: p.percent, done: false })
  })

  // A newer version exists — offer it. One consent up front: accepting
  // downloads the update and restarts into it when the bytes are in, with no
  // second dialog. Declining just waits for the next check.
  autoUpdater.on('update-available', (info) => {
    if (prompting) return
    prompting = true
    const win = BrowserWindow.getAllWindows()[0]
    dialog
      .showMessageBox(win, {
        type: 'info',
        buttons: ['Update and Restart', 'Not now'],
        defaultId: 0,
        cancelId: 1,
        message: `Version ${info.version} is available`,
        detail: 'Downloads the update, then restarts thinking canvas to install it.'
      })
      .then(({ response }) => {
        prompting = false
        if (response === 0) void autoUpdater.downloadUpdate()
      })
      .catch(() => {
        prompting = false
      })
  })

  // Download finished — the user already consented at the "update available"
  // prompt, so restart into the new version immediately, no second dialog.
  autoUpdater.on('update-downloaded', () => {
    const win = BrowserWindow.getAllWindows()[0]
    if (win && !win.isDestroyed()) {
      win.setProgressBar(-1) // clear the Dock bar
      win.webContents.send('update:progress', { percent: 100, done: true })
    }
    // Hand off to Squirrel. quitAndInstall submits the ShipIt helper to
    // launchd, then terminates this process; ShipIt waits for us to die,
    // swaps the bundle in /Applications, and relaunches.
    //
    // Two macOS 26 failure modes, both observed here:
    //  1. quitAndInstall's launchd job registers but never starts (runs = 0),
    //     stranding the staged update.
    //  2. quitAndInstall sometimes doesn't terminate this process — the window
    //     closes but the process lingers, and if ShipIt runs while the app is
    //     alive it (correctly) aborts the install.
    // ShipIt itself installs perfectly once the app is dead and the job is
    // started. So leave behind a detached kicker that waits for this process
    // to exit (force-killing it if it lingers past a grace period), then
    // starts the job. Where launchd behaves on its own, this is a no-op.
    //
    // Do NOT app.exit() inline as a "fallback": a hard exit races the launchd
    // handoff and strands the install before the job is even submitted.
    const kickerScript = [
      // wait up to 15s for the app process to exit on its own
      `for i in $(seq 1 15); do kill -0 ${process.pid} 2>/dev/null || break; sleep 1; done`,
      // ghost process: force it dead so ShipIt won't abort
      `kill -9 ${process.pid} 2>/dev/null`,
      'sleep 1',
      `/bin/launchctl kickstart gui/${process.getuid?.() ?? 501}/${SHIPIT_JOB}`
    ].join('; ')
    const kicker = spawn('/bin/sh', ['-c', kickerScript], { detached: true, stdio: 'ignore' })
    kicker.unref()
    setImmediate(() => autoUpdater.quitAndInstall(false, true))
  })

  void autoUpdater.checkForUpdates()
  setInterval(() => void autoUpdater.checkForUpdates(), CHECK_INTERVAL_MS)
}
