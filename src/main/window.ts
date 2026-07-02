import { app, BrowserWindow, session, shell } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { BROWSE_PARTITION } from '../shared/types'

export function createWindow(): void {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: 1600,
    height: 1000,
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      // tab nodes embed web pages in <webview> guests (hardened below in
      // the app-wide web-contents-created hook)
      webviewTag: true
    }
  })

  // once, NOT on: ready-to-show can re-fire after boot (renderer re-renders,
  // e.g. following GPU-process hiccups), and show() on macOS ACTIVATES the
  // app — a repeated handler here was yanking OS focus from other apps
  // mid-computer-use-turn (found via stack trace on BrowserWindow.show).
  mainWindow.once('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // Safety net: the app's own window must never navigate away to a page —
  // that would tear down the whole renderer (the bug where a clicked link took
  // over the window). The renderer routes link clicks into in-app tabs itself;
  // anything that still slips through to a real navigation is bounced to the OS
  // browser instead. The dev-server / file load that boots the app is allowed.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const appUrl = process.env['ELECTRON_RENDERER_URL']
    const isAppBoot = url.startsWith('file://') || (appUrl ? url.startsWith(appUrl) : false)
    if (isAppBoot) return
    event.preventDefault()
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
  })

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}
export function hardenWebContents(): void {
  // Tab nodes run remote pages in <webview> guests. Lock every guest down:
  // no preload, no node access, http(s) URLs only — and anything a page tries
  // to pop open goes to the system browser instead of a new window.
  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-attach-webview', (event, webPreferences, params) => {
      delete webPreferences.preload
      webPreferences.nodeIntegration = false
      webPreferences.contextIsolation = true
      // A YouTube link opens to a paused player, not an auto-playing one:
      // a guest can't start media until the user clicks/taps inside it.
      webPreferences.autoplayPolicy = 'document-user-activation-required'
      if (!/^https?:\/\//i.test(params.src ?? '')) event.preventDefault()
    })
    if (contents.getType() === 'webview') {
      // Trackpad pinch-to-zoom is off by default on a guest (Chromium clamps
      // visual-zoom limits to 1,1). Open them so a pinch zooms the page; no
      // renderer-side wheel handling can substitute for this — the limit lives
      // on the guest's own webContents.
      contents.setVisualZoomLevelLimits(1, 3).catch(() => {})
      // A tab node is one tab on purpose: anything its page tries to pop open
      // (target=_blank, window.open, ⌘-click) navigates that tab's own guest
      // instead of spawning a window — so ⌘-click behaves exactly like a plain
      // click. The guest needs the allowpopups attribute for these to surface
      // here at all (set on the <webview> in TabBrowser). Plain in-page links
      // navigate the guest directly and never reach this handler.
      contents.setWindowOpenHandler(({ url }) => {
        if (/^https?:\/\//i.test(url)) void contents.loadURL(url)
        return { action: 'deny' }
      })
    }
  })
}

export function setupBrowsePermissions(): void {
  const browsePermissionAllowed = (permission: string): boolean =>
    permission === 'fullscreen' || permission === 'pointerLock'
  const browse = session.fromPartition(BROWSE_PARTITION)
  browse.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(browsePermissionAllowed(permission))
  })
  browse.setPermissionCheckHandler((_wc, permission) => browsePermissionAllowed(permission))
}
