import { app, shell, BrowserWindow, dialog, ipcMain } from 'electron'
import { promises as fs, readFileSync } from 'fs'
import { basename, join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { query } from '@anthropic-ai/claude-agent-sdk'
import icon from '../../resources/icon.png?asset'
import type { CanvasDoc, RepoState } from '../shared/types'

// The repo the canvas is rooted at: the agent's cwd and the home of
// .canvas/canvas.json. Chosen by the user and remembered across launches —
// null until a repo has been picked (the renderer shows a picker prompt).
let repoRoot: string | null = null

interface RepoSettings {
  current: string | null
  recents: string[]
}

const settingsFile = (): string => join(app.getPath('userData'), 'repos.json')

async function readSettings(): Promise<RepoSettings> {
  try {
    return JSON.parse(await fs.readFile(settingsFile(), 'utf8'))
  } catch {
    return { current: null, recents: [] }
  }
}

const canvasFileFor = (root: string): string => join(root, '.canvas', 'canvas.json')

async function dirExists(path: string): Promise<boolean> {
  try {
    return (await fs.stat(path)).isDirectory()
  } catch {
    return false
  }
}

async function chatCountFor(root: string): Promise<number> {
  try {
    const doc: CanvasDoc = JSON.parse(await fs.readFile(canvasFileFor(root), 'utf8'))
    return doc.nodes.filter((n) => n.title || (n.messages?.length ?? 0) > 0).length
  } catch {
    return 0
  }
}

async function buildRepoState(): Promise<RepoState> {
  const settings = await readSettings()
  const recents: RepoState['recents'] = []
  for (const path of settings.recents) {
    if (!(await dirExists(path))) continue
    const chatCount = await chatCountFor(path)
    // Only repos you actually chatted in earn a recents slot (plus the open one).
    if (chatCount > 0 || path === repoRoot) {
      recents.push({ path, name: basename(path), chatCount })
    }
  }
  return { current: repoRoot, recents }
}

async function setCurrentRepo(root: string): Promise<RepoState> {
  repoRoot = root
  const settings = await readSettings()
  settings.current = root
  settings.recents = [root, ...settings.recents.filter((r) => r !== root)].slice(0, 20)
  await fs.writeFile(settingsFile(), JSON.stringify(settings, null, 2))
  return buildRepoState()
}

function registerRepoIpc(): void {
  ipcMain.handle('repo:get', () => buildRepoState())

  ipcMain.handle('repo:choose', async (event): Promise<RepoState | null> => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const options = {
      title: 'Choose a repository',
      properties: ['openDirectory' as const, 'createDirectory' as const]
    }
    const res = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options)
    if (res.canceled || res.filePaths.length === 0) return null
    return setCurrentRepo(res.filePaths[0])
  })

  ipcMain.handle('repo:select', async (_event, path: string): Promise<RepoState> => {
    if (await dirExists(path)) return setCurrentRepo(path)
    return buildRepoState() // gone from disk — the rebuilt state simply drops it
  })
}

// Minimal .env loader (ANTHROPIC_API_KEY etc.) — real values never leave the main
// process. Read from the app's own launch dir, independent of the chosen repo.
function loadDotEnv(): void {
  try {
    for (const line of readFileSync(join(process.cwd(), '.env'), 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/)
      if (m && process.env[m[1]] === undefined) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
      }
    }
  } catch {
    // no .env — fine if the key is already in the environment
  }
}

interface ThreadSendArgs {
  nodeId: string
  text: string
  sessionId?: string
}

type ThreadEvent =
  | { nodeId: string; type: 'session'; sessionId: string }
  | { nodeId: string; type: 'delta'; text: string }
  | { nodeId: string; type: 'done'; ok: boolean; error?: string }

function registerThreadIpc(): void {
  ipcMain.handle('thread:send', async (event, { nodeId, text, sessionId }: ThreadSendArgs) => {
    const wc = event.sender
    const emit = (payload: ThreadEvent): void => {
      if (!wc.isDestroyed()) wc.send('thread:event', payload)
    }

    const root = repoRoot
    if (!root) {
      emit({ nodeId, type: 'done', ok: false, error: 'No repository selected' })
      return
    }

    try {
      const turn = query({
        prompt: text,
        options: {
          cwd: root,
          resume: sessionId,
          systemPrompt: { type: 'preset', preset: 'claude_code' },
          settingSources: ['project'], // required or CLAUDE.md is not loaded
          permissionMode: 'acceptEdits',
          includePartialMessages: true
        }
      })

      for await (const msg of turn) {
        if (msg.type === 'system' && msg.subtype === 'init') {
          emit({ nodeId, type: 'session', sessionId: msg.session_id })
        } else if (msg.type === 'stream_event') {
          const ev = msg.event
          if (
            ev.type === 'content_block_delta' &&
            ev.delta.type === 'text_delta' &&
            msg.parent_tool_use_id === null
          ) {
            emit({ nodeId, type: 'delta', text: ev.delta.text })
          }
        } else if (msg.type === 'result') {
          emit({
            nodeId,
            type: 'done',
            ok: msg.subtype === 'success',
            ...(msg.subtype !== 'success' ? { error: msg.subtype } : {})
          })
        }
      }
    } catch (err) {
      emit({ nodeId, type: 'done', ok: false, error: String(err) })
    }
  })
}

function registerCanvasIpc(): void {
  ipcMain.handle('canvas:load', async (): Promise<CanvasDoc | null> => {
    if (!repoRoot) return null
    try {
      return JSON.parse(await fs.readFile(canvasFileFor(repoRoot), 'utf8'))
    } catch {
      return null
    }
  })

  ipcMain.handle('canvas:save', async (_event, doc: CanvasDoc): Promise<void> => {
    if (!repoRoot) return
    const dir = join(repoRoot, '.canvas')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(join(dir, 'canvas.json'), JSON.stringify(doc, null, 2))
  })
}

function createWindow(): void {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: 1600,
    height: 1000,
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(async () => {
  // Set app user model id for windows
  electronApp.setAppUserModelId('com.electron')

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  loadDotEnv()

  // Reopen the repo from last time if it still exists.
  const settings = await readSettings()
  if (settings.current && (await dirExists(settings.current))) repoRoot = settings.current

  registerCanvasIpc()
  registerThreadIpc()
  registerRepoIpc()

  createWindow()

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

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
