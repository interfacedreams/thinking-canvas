import {
  app,
  shell,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  safeStorage,
  session
} from 'electron'
import { randomUUID } from 'crypto'
import { promises as fs, readFileSync, constants as fsConstants } from 'fs'
import { tmpdir } from 'os'
import { basename, extname, isAbsolute, join, relative, resolve } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { ElectronBlocker, adsAndTrackingLists } from '@ghostery/adblocker-electron'
import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import icon from '../../resources/icon.png?asset'
import {
  BROWSE_PARTITION,
  DEFAULT_MODEL,
  DEFAULT_PERMISSION_SETTINGS,
  MODEL_OPTIONS,
  TITLE_MODEL
} from '../shared/types'
import type {
  AuthStatus,
  CanvasDoc,
  ChosenFile,
  FolderState,
  ModelId,
  PermissionReply,
  PermissionSettings,
  PersistedMessage,
  ThreadDoc,
  ThreadEvent,
  ThreadSendArgs
} from '../shared/types'

// The folder the canvas is rooted at: the agent's cwd and the home of
// .canvas/canvas.json. Chosen by the user and remembered across launches —
// null until a folder has been picked (the renderer shows a picker prompt).
let folderRoot: string | null = null

interface FolderSettings {
  current: string | null
  recents: string[]
}

const settingsFile = (): string => join(app.getPath('userData'), 'folders.json')
// Pre-rename installs kept their state in repos.json — read it as a fallback.
const legacySettingsFile = (): string => join(app.getPath('userData'), 'repos.json')

async function readSettings(): Promise<FolderSettings> {
  for (const file of [settingsFile(), legacySettingsFile()]) {
    try {
      return JSON.parse(await fs.readFile(file, 'utf8'))
    } catch {
      // missing or unreadable — try the next
    }
  }
  return { current: null, recents: [] }
}

const canvasFileFor = (root: string): string => join(root, '.canvas', 'canvas.json')
const threadsDirFor = (root: string): string => join(root, '.canvas', 'threads')
const threadFileFor = (root: string, nodeId: string): string =>
  join(threadsDirFor(root), `${nodeId}.json`)
// Pre-migration note bodies (and now-retired version sidecars) live here,
// keyed by node id.
const noteMetaDirFor = (root: string): string => join(root, '.canvas', 'notes')
const legacyNoteFileFor = (root: string, nodeId: string): string =>
  join(noteMetaDirFor(root), `${nodeId}.md`)
const legacyNoteVersionsFileFor = (root: string, nodeId: string): string =>
  join(noteMetaDirFor(root), `${nodeId}.versions.json`)

// Node ids come from the renderer over IPC — keep them path-segment safe.
const isSafeNodeId = (nodeId: string): boolean => /^[\w-]+$/.test(nodeId)

// --- Note files ---------------------------------------------------------
// A note's live content is a title-named markdown file at the folder root
// ("Auth ideas.md"). The id→filename map is the authority: rebuilt from
// canvas.json on load, mutated by create/rename/delete, and injected back
// into canvas.json on save.
const noteFiles = new Map<string, string>()

const notePathFor = (root: string, nodeId: string): string | null => {
  const file = noteFiles.get(nodeId)
  return file ? join(root, file) : null
}

// Filenames round-trip through canvas.json — only accept plain root-level
// markdown filenames on the way back in.
const isSafeNoteFile = (file: string): boolean =>
  /^[^/\\]+\.md$/.test(file) && !file.startsWith('.')

// Filename = title: keep it human, strip only what a path can't take.
function sanitizeTitle(title: string): string {
  return title
    .replace(/[/\\:]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+/, '') // no hidden files
    .replace(/[.\s]+$/, '')
    .slice(0, 120)
    .trim()
}

/**
 * First free title at the folder root: "Foo", "Foo 2", … Checked against the
 * filesystem itself (APFS is case-insensitive, so this doubles as the
 * case-insensitive uniqueness check) — a note never clobbers any existing
 * file, the folder's own markdown included. `keep` is the note's current
 * filename, which always counts as free (renaming to yourself is a no-op).
 */
async function allocateNoteFile(
  root: string,
  wanted: string,
  keep?: string
): Promise<{ title: string; file: string }> {
  const base = sanitizeTitle(wanted) || 'Untitled'
  for (let n = 1; ; n++) {
    const title = n === 1 ? base : `${base} ${n}`
    const file = `${title}.md`
    if (keep && file.toLowerCase() === keep.toLowerCase()) return { title, file }
    try {
      await fs.access(join(root, file))
    } catch {
      return { title, file }
    }
  }
}

/** Create an empty note file under the first free title-derived name. */
async function createNoteFile(
  root: string,
  wanted: string
): Promise<{ title: string; file: string }> {
  for (let attempt = 0; ; attempt++) {
    const slot = await allocateNoteFile(root, wanted)
    try {
      // wx: fail rather than overwrite if something claimed the name since the check
      await fs.writeFile(join(root, slot.file), '', { flag: 'wx' })
      return slot
    } catch (err) {
      if (attempt >= 5) throw err
    }
  }
}

/** Move a note file to a (possibly retitled) name, never clobbering anything. */
async function moveNoteFile(
  root: string,
  oldRel: string,
  wanted: string
): Promise<{ title: string; file: string }> {
  const slot = await allocateNoteFile(root, wanted, oldRel)
  if (slot.file === oldRel) return slot
  const oldPath = join(root, oldRel)
  const newPath = join(root, slot.file)
  if (slot.file.toLowerCase() === oldRel.toLowerCase()) {
    // case-only change: same file on APFS, so a plain rename can't clobber
    await fs.rename(oldPath, newPath)
  } else {
    // link refuses to overwrite an existing target — the no-clobber guarantee
    await fs.link(oldPath, newPath)
    await fs.unlink(oldPath)
  }
  return slot
}

async function readTextIfExists(path: string): Promise<string> {
  try {
    return await fs.readFile(path, 'utf8')
  } catch {
    return ''
  }
}

// --- File nodes -----------------------------------------------------------
// A file node references an image or PDF inside the folder by relative path.
// Picking a file outside the folder copies it to the root; one already inside
// is referenced where it sits. Deleting a node never deletes the file.

type ImageMime = 'image/png' | 'image/jpeg'
type PdfMime = 'application/pdf'
type FileMime = ImageMime | PdfMime
const FILE_MIME: Record<string, FileMime> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  pdf: 'application/pdf'
}

const fileMimeFor = (file: string): FileMime | null =>
  FILE_MIME[extname(file).slice(1).toLowerCase()] ?? null

const imageMimeFor = (file: string): ImageMime | null => {
  const mime = fileMimeFor(file)
  return mime && mime !== 'application/pdf' ? mime : null
}

// The API caps the whole request at 32 MB, and base64 inflates by a third —
// past this a PDF can't reach the model, so refuse it at pick time.
const MAX_PDF_BYTES = 20 * 1024 * 1024

// Link-node URLs come from the renderer's own normalizer, but re-check here
// since they steer an auto-approved WebFetch.
const isHttpUrl = (url: string): boolean => {
  try {
    const u = new URL(url)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

/** The URL's origin, or null if unparsable. */
const originOf = (url: string): string | null => {
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}

// File-node paths round-trip through canvas.json — accept only relative
// paths that stay inside the root, with no hidden or parent segments.
const isSafeFileRel = (rel: string): boolean =>
  rel.length > 0 &&
  !rel.includes('\\') &&
  rel.split('/').every((seg) => seg !== '' && !seg.startsWith('.'))

async function imageDataUrl(root: string, rel: string): Promise<string | undefined> {
  const mime = imageMimeFor(rel)
  if (!mime) return undefined
  try {
    const buf = await fs.readFile(join(root, rel))
    return `data:${mime};base64,${buf.toString('base64')}`
  } catch {
    return undefined // moved or deleted — the node renders a missing-image placeholder
  }
}

// Describe a pickable file for the renderer: images carry preview bytes as a
// data URL so they can be measured before placing; PDFs travel as a path only
// (their bytes never enter the renderer), size-capped so they can reach the
// model. Null for unsupported, oversized, or unreadable files.
async function chosenFileFor(path: string): Promise<ChosenFile | null> {
  const mime = fileMimeFor(path)
  if (!mime) return null
  try {
    if (mime === 'application/pdf') {
      if ((await fs.stat(path)).size > MAX_PDF_BYTES) {
        console.warn(`[file] PDF over ${MAX_PDF_BYTES / 1024 / 1024}MB refused: ${path}`)
        return null
      }
      return { sourcePath: path, name: basename(path), kind: 'pdf' }
    }
    const buf = await fs.readFile(path)
    return {
      sourcePath: path,
      name: basename(path),
      kind: 'image',
      dataUrl: `data:${mime};base64,${buf.toString('base64')}`
    }
  } catch {
    return null
  }
}

function registerFileIpc(): void {
  // Pick an image or PDF via the open dialog.
  ipcMain.handle('file:choose', async (event): Promise<ChosenFile | null> => {
    if (!folderRoot) return null
    const win = BrowserWindow.fromWebContents(event.sender)
    const options = {
      title: 'Add an image or PDF',
      properties: ['openFile' as const],
      filters: [{ name: 'Images & PDFs', extensions: ['png', 'jpg', 'jpeg', 'pdf'] }]
    }
    const res = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options)
    if (res.canceled || res.filePaths.length === 0) return null
    return chosenFileFor(res.filePaths[0])
  })

  // A file dragged in from the OS — same description (and same vetting) as a
  // picked one, from the drop's absolute path.
  ipcMain.handle('file:fromPath', async (_event, path: string): Promise<ChosenFile | null> => {
    if (!folderRoot || typeof path !== 'string' || !isAbsolute(path)) return null
    return chosenFileFor(path)
  })

  // A photo on the clipboard (a screenshot, an image copied out of a
  // browser) — staged to a temp file so the regular attach flow can copy it
  // into the folder under a free name, exactly like a picked or dropped one.
  ipcMain.handle('file:fromClipboard', async (): Promise<ChosenFile | null> => {
    if (!folderRoot) return null
    const image = clipboard.readImage()
    if (image.isEmpty()) return null
    try {
      const png = image.toPNG()
      const dir = await fs.mkdtemp(join(tmpdir(), 'bee-claude-paste-'))
      const sourcePath = join(dir, 'Pasted image.png')
      await fs.writeFile(sourcePath, png)
      return {
        sourcePath,
        name: 'Pasted image.png',
        kind: 'image',
        dataUrl: `data:image/png;base64,${png.toString('base64')}`
      }
    } catch {
      return null
    }
  })

  // Bytes for the renderer's inline PDF viewer (pdf.js renders pages onto
  // canvases). PDFs only — image previews already travel as data URLs.
  ipcMain.handle('file:pdfData', async (_event, rel: string): Promise<Uint8Array | null> => {
    const root = folderRoot
    if (!root || typeof rel !== 'string' || !isSafeFileRel(rel)) return null
    if (fileMimeFor(rel) !== 'application/pdf') return null
    try {
      return await fs.readFile(join(root, rel))
    } catch {
      return null // moved or deleted — the node renders its missing-file card
    }
  })

  // The node was placed — make the file part of the folder. Inside the root
  // it's referenced in place; outside, copied in under a free name.
  ipcMain.handle(
    'file:attach',
    async (_event, sourcePath: string): Promise<{ file: string } | null> => {
      const root = folderRoot
      if (!root || typeof sourcePath !== 'string' || !fileMimeFor(sourcePath)) return null
      const src = resolve(sourcePath)
      const rel = relative(root, src)
      if (!rel.startsWith('..') && !isAbsolute(rel)) {
        return isSafeFileRel(rel) ? { file: rel } : null
      }
      const ext = extname(src)
      const base = sanitizeTitle(basename(src, ext)) || 'file'
      try {
        for (let n = 1; n <= 200; n++) {
          const file = n === 1 ? `${base}${ext}` : `${base} ${n}${ext}`
          try {
            // COPYFILE_EXCL refuses to overwrite — the no-clobber guarantee
            await fs.copyFile(src, join(root, file), fsConstants.COPYFILE_EXCL)
            return { file }
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
          }
        }
      } catch {
        // unreadable source or unwritable root — the node keeps its preview only
      }
      return null
    }
  )
}

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
    // A title marks a chat: it's stamped on the first send (and on fork).
    return doc.nodes.filter((n) => n.title).length
  } catch {
    return 0
  }
}

async function buildFolderState(): Promise<FolderState> {
  const settings = await readSettings()
  const recents: FolderState['recents'] = []
  for (const path of settings.recents) {
    if (!(await dirExists(path))) continue
    const chatCount = await chatCountFor(path)
    // Only folders you actually chatted in earn a recents slot (plus the open one).
    if (chatCount > 0 || path === folderRoot) {
      recents.push({ path, name: basename(path), chatCount })
    }
  }
  return { current: folderRoot, recents }
}

async function setCurrentFolder(root: string): Promise<FolderState> {
  folderRoot = root
  noteFiles.clear() // rebuilt by the next canvas:load
  const settings = await readSettings()
  settings.current = root
  settings.recents = [root, ...settings.recents.filter((r) => r !== root)].slice(0, 20)
  await fs.writeFile(settingsFile(), JSON.stringify(settings, null, 2))
  return buildFolderState()
}

function registerFolderIpc(): void {
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
}

// Minimal .env loader (ANTHROPIC_API_KEY etc.) — real values never leave the main
// process. Read from the app's own launch dir, independent of the chosen folder.
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

// Claude subscription auth: a long-lived OAuth token from `claude setup-token`
// stored in userData (encrypted when the OS keychain is available). The agent
// SDK subprocess inherits our env, so choosing it means exporting
// CLAUDE_CODE_OAUTH_TOKEN and removing ANTHROPIC_API_KEY — inside the CLI an
// API key would otherwise take precedence over the subscription token.

const authFile = (): string => join(app.getPath('userData'), 'auth.json')

let envApiKey: string | undefined // the .env/environment key, kept so clearing the token restores it
let oauthToken: string | null = null

async function readStoredToken(): Promise<string | null> {
  try {
    const raw = JSON.parse(await fs.readFile(authFile(), 'utf8'))
    if (typeof raw.encrypted === 'string' && safeStorage.isEncryptionAvailable()) {
      return safeStorage.decryptString(Buffer.from(raw.encrypted, 'base64')) || null
    }
    if (typeof raw.token === 'string' && raw.token) return raw.token
  } catch {
    // missing or unreadable — treated as no token
  }
  return null
}

async function writeStoredToken(token: string): Promise<void> {
  const body = safeStorage.isEncryptionAvailable()
    ? { encrypted: safeStorage.encryptString(token).toString('base64') }
    : { token }
  await fs.writeFile(authFile(), JSON.stringify(body), { mode: 0o600 })
}

function applyAuthEnv(): void {
  if (oauthToken) {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = oauthToken
    delete process.env.ANTHROPIC_API_KEY
  } else {
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN
    if (envApiKey !== undefined) process.env.ANTHROPIC_API_KEY = envApiKey
  }
}

function authStatus(): AuthStatus {
  return {
    method: oauthToken ? 'subscription' : envApiKey ? 'apiKey' : 'none',
    tokenSuffix: oauthToken ? oauthToken.slice(-4) : null,
    hasApiKey: envApiKey !== undefined
  }
}

function registerAuthIpc(): void {
  ipcMain.handle('auth:status', (): AuthStatus => authStatus())

  ipcMain.handle('auth:setToken', async (_event, token: string): Promise<AuthStatus> => {
    const trimmed = String(token).trim()
    // setup-token output starts with sk-ant-oat…; accept any sk-ant- prefix
    // so a future prefix change doesn't lock users out.
    if (!trimmed.startsWith('sk-ant-')) {
      throw new Error('That does not look like a Claude token (expected sk-ant-…)')
    }
    oauthToken = trimmed
    await writeStoredToken(trimmed)
    applyAuthEnv()
    return authStatus()
  })

  ipcMain.handle('auth:clearToken', async (): Promise<AuthStatus> => {
    oauthToken = null
    await fs.rm(authFile(), { force: true })
    applyAuthEnv()
    return authStatus()
  })
}

// --- Global permission settings -----------------------------------------
// App-wide auto-allow preferences, persisted in userData. Enforced inside
// canUseTool, so a change applies to the very next tool call — and any
// prompt already waiting on screen that the new settings cover is resolved
// on the spot (canUseTool's own permission-resolved emit dismisses it).

const permissionsFile = (): string => join(app.getPath('userData'), 'permissions.json')

let permissionSettings: PermissionSettings = { ...DEFAULT_PERMISSION_SETTINGS }

async function readPermissionSettings(): Promise<PermissionSettings> {
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

function autoAllowed(toolName: string): boolean {
  if (permissionSettings.autoAllowAll) return true
  return permissionSettings.allowWebSearch && (toolName === 'WebSearch' || toolName === 'WebFetch')
}

// Permission requests in flight: requestId → the tool asked about and the
// resolver for the user's verdict. canUseTool blocks the SDK turn until the
// renderer answers via thread:permission (or a settings change covers it).
const pendingPermissions = new Map<
  string,
  { toolName: string; resolve: (allow: boolean) => void }
>()

function registerPermissionSettingsIpc(): void {
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

// --- Ad blocking ----------------------------------------------------------
// Network-level ad/tracker blocking (the EasyList family) on the shared
// browse partition, so every tab guest gets it. Cosmetic filtering stays off
// on purpose: it would register a preload in the guests, and the
// will-attach-webview hardening wants guests preload-free — network blocking
// alone catches the bulk anyway. The compiled engine caches to userData, so
// only the first launch (or a list refresh) hits the network.

const adblockSettingsFile = (): string => join(app.getPath('userData'), 'adblock.json')

let adblockEnabled = true
let adblockEngine: ElectronBlocker | null = null

async function readAdblockEnabled(): Promise<boolean> {
  try {
    // on by default — only an explicit { enabled: false } turns it off
    return JSON.parse(await fs.readFile(adblockSettingsFile(), 'utf8')).enabled !== false
  } catch {
    return true
  }
}

function applyAdblock(): void {
  if (!adblockEngine) return
  const browse = session.fromPartition(BROWSE_PARTITION)
  if (adblockEnabled) {
    adblockEngine.enableBlockingInSession(browse) // idempotent
  } else if (adblockEngine.isBlockingEnabled(browse)) {
    adblockEngine.disableBlockingInSession(browse)
  }
}

async function initAdblock(): Promise<void> {
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

function registerAdblockIpc(): void {
  ipcMain.handle('adblock:get', (): boolean => adblockEnabled)

  ipcMain.handle('adblock:set', async (_event, enabled: boolean): Promise<boolean> => {
    adblockEnabled = enabled === true
    applyAdblock()
    await fs.writeFile(adblockSettingsFile(), JSON.stringify({ enabled: adblockEnabled }, null, 2))
    return adblockEnabled
  })
}

// Research mode: the lead agent of a chat turn may spawn these subagents.
// Each spawn renders as a display-only child node on the canvas.
const RESEARCHER_DEF = {
  description: 'Focused web researcher for one angle of a question',
  prompt:
    'You are a focused web researcher. Use WebSearch to find sources and WebFetch to read the most ' +
    'promising ones. Cross-check important claims. Return a concise report: key findings as bullets ' +
    'with source URLs inline, ending with a list of all sources used.',
  tools: ['WebSearch', 'WebFetch']
}
const RESEARCH_APPEND =
  'Research mode is on for this request. Plan briefly, then spawn 2-3 researcher subagents IN PARALLEL ' +
  '(one message with multiple Agent tool calls, subagent_type: "researcher"), each covering a distinct ' +
  'angle. When they return, summarize the findings in 2-3 sentences. Only if a critical gap remains, run ' +
  'ONE follow-up round of at most 2 researchers. Then write the final report: structured markdown with ' +
  'inline numbered citations [1] and a Sources section listing every URL.'

function registerThreadIpc(): void {
  // Chat titles: a lazy one-shot Haiku turn after a chat's first exchange.
  // Tool-less and session-less — it never touches the chat's own session.
  ipcMain.handle('thread:title', async (_event, conversation: string): Promise<string | null> => {
    const root = folderRoot
    if (!root) return null
    try {
      const turn = query({
        prompt:
          'Write a title for the conversation below: 3-6 words, plain text, no quotes, ' +
          'no trailing punctuation. Reply with the title only.\n\n' +
          conversation,
        options: {
          cwd: root,
          model: TITLE_MODEL,
          maxTurns: 1,
          tools: [], // text-only turn — no tools, so no permission round-trips
          systemPrompt: 'You write concise titles. Reply with only the title.'
        }
      })
      for await (const msg of turn) {
        if (msg.type === 'result') {
          if (msg.subtype !== 'success') return null
          const title = msg.result
            .trim()
            .replace(/^["'“”]+|["'“”.]+$/g, '')
            .replace(/\s+/g, ' ')
            .slice(0, 60)
            .trim()
          return title || null
        }
      }
    } catch {
      // a failed title is just no title — the send-time stub stays
    }
    return null
  })

  ipcMain.on('thread:permission', (_event, { requestId, allow }: PermissionReply) => {
    pendingPermissions.get(requestId)?.resolve(allow)
  })

  // File-mutating tools a note session may only point at its own file.
  const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

  ipcMain.handle(
    'thread:send',
    async (
      event,
      {
        nodeId,
        text,
        sessionId,
        forkFrom,
        kind,
        noteTitle,
        research,
        model,
        contextNotes,
        contextFiles,
        contextLinks
      }: ThreadSendArgs
    ) => {
      // The renderer sends an id from MODEL_OPTIONS; anything else falls back.
      const turnModel = MODEL_OPTIONS.some((m) => m.id === model)
        ? (model as ModelId)
        : DEFAULT_MODEL
      const wc = event.sender
      const emit = (payload: ThreadEvent): void => {
        if (!wc.isDestroyed()) wc.send('thread:event', payload)
      }

      console.log(
        `[thread:send] node=${nodeId.slice(0, 8)} kind=${kind ?? 'chat'} research=${research === true}` +
          ` resume=${(forkFrom?.sessionId ?? sessionId)?.slice(0, 8) ?? 'fresh'}`
      )

      const root = folderRoot
      if (!root) {
        emit({ nodeId, type: 'done', ok: false, error: 'No folder selected' })
        return
      }

      const notePath = kind === 'note' && isSafeNodeId(nodeId) ? notePathFor(root, nodeId) : null
      if (kind === 'note' && !notePath) {
        emit({ nodeId, type: 'done', ok: false, error: 'Unknown note' })
        return
      }

      try {
        if (notePath) {
          // The Edit tool needs a file to edit — make sure it exists.
          try {
            await fs.access(notePath)
          } catch {
            await fs.writeFile(notePath, '')
          }
        }

        // Connected notes ride the system prompt, re-read from the canvas on
        // every send — edit a note and the chat's next turn sees the new text.
        // Prompt caching tolerates this: a changed note only means one cache
        // miss on the system-prompt prefix (it re-caches immediately); the
        // conversation itself is untouched since each turn resumes the session.
        // The framing is deliberately authoritative — the agent must answer
        // from these blocks instead of burning a turn re-discovering the same
        // notes on disk (each block names its file so the agent can tell).
        const contextAppend =
          contextNotes && contextNotes.length > 0
            ? 'The user attached notes to this conversation. Their full, current contents ' +
              'are below, refreshed on every message — this IS the live content of the ' +
              'named files, so never search the project, check memory, or read these files ' +
              'from disk to find this information. Just answer from what is here.\n\n' +
              contextNotes
                .map((n) => {
                  const file = noteFiles.get(n.id)
                  const attrs =
                    `title=${JSON.stringify(n.title)}` +
                    (file ? ` file=${JSON.stringify(file)}` : '')
                  return `<note ${attrs}>\n${n.content}\n</note>`
                })
                .join('\n')
            : ''
        // Connected files (images and PDFs) live IN the conversation, not the
        // system prompt (the API's system prompt is text-only): a file newly
        // connected since the session last saw it rides this turn's user
        // message as a real image/document block — once. Later turns resume
        // the session, which already holds the bytes, so the system prompt
        // only lists titles. PDFs arrive as document blocks; the API renders
        // each page as an image plus its extracted text, so the model sees
        // layout and charts as well as the words.
        const validFiles = (contextFiles ?? []).filter(
          (f) => typeof f.file === 'string' && isSafeFileRel(f.file)
        )
        const filesAppend =
          validFiles.length > 0
            ? 'The user attached files (images or PDF documents) to this conversation: ' +
              validFiles.map((f) => JSON.stringify(f.title)).join(', ') +
              '. They are included as attachments inside the conversation ' +
              'messages themselves — answer from what you see in them. Never try ' +
              'to read them from disk or search the project for them.'
            : ''
        // Connected links ride the system prompt like notes do: the renderer
        // reads each tab's rendered page out of its live <webview> guest as
        // markdown (so bot walls and JS-only pages that blank a plain fetch
        // don't matter — the model reads what the user sees), refreshed on
        // every send. Navigating the tab is one cache miss on the prefix,
        // same as editing a note. A link that arrived without content (tab
        // minimized, page hung) falls back to the original contract: bare
        // URL plus an instruction to WebFetch it, the fetched page living in
        // the session transcript from then on.
        const validLinks = (contextLinks ?? []).filter(
          (l) => typeof l.url === 'string' && isHttpUrl(l.url)
        )
        // The renderer caps extraction at 80k chars — re-clamp here since the
        // content steers straight into the system prompt.
        const liveLinks = validLinks.flatMap((l) =>
          typeof l.content === 'string' && l.content.trim()
            ? [{ ...l, content: l.content.slice(0, 100_000) }]
            : []
        )
        const fetchLinks = validLinks.filter(
          (l) => !(typeof l.content === 'string' && l.content.trim())
        )
        const linksAppend = [
          liveLinks.length > 0
            ? 'The user attached web pages to this conversation. Each <page> block below is ' +
              "the page's rendered text, read out of the user's own browser tab and refreshed " +
              'on every message — this IS the live page, so answer from it and never WebFetch ' +
              'a URL whose content is already here.\n\n' +
              liveLinks
                .map(
                  (l) =>
                    `<page title=${JSON.stringify(l.title)} url=${JSON.stringify(l.url)}>\n` +
                    `${l.content}\n</page>`
                )
                .join('\n')
            : '',
          fetchLinks.length > 0
            ? 'The user attached web pages to this conversation:\n' +
              fetchLinks
                .map(
                  (l) => `<page title=${JSON.stringify(l.title)} url=${JSON.stringify(l.url)} />`
                )
                .join('\n') +
              '\nBefore answering, fetch each attached page with WebFetch — unless this ' +
              'conversation already contains its fetched content from an earlier turn ' +
              '(never re-fetch a page you already hold). Answer from the fetched content.'
            : ''
        ]
          .filter(Boolean)
          .join('\n\n')
        const systemAppend = [
          contextAppend,
          filesAppend,
          linksAppend,
          research ? RESEARCH_APPEND : ''
        ]
          .filter(Boolean)
          .join('\n\n')

        const prompt = notePath
          ? `You are connected to the markdown note "${noteTitle || 'Untitled'}" at ${notePath}. ` +
            `Apply the instruction below by editing that file directly — use the Edit tool ` +
            `(or Write if the file is empty). Never create or modify any other file. ` +
            `Write each paragraph as one long line — never hard-wrap prose at a column ` +
            `width or end lines with trailing spaces; the note editor wraps text to fit. ` +
            `Keep your text reply to a sentence or two; the edits speak for themselves.` +
            `\n\nInstruction: ${text}`
          : text

        // Bytes for the files this turn introduces, each behind a title label
        // so the model can tell which attachment is which.
        const fileBlocks: Array<
          | { type: 'text'; text: string }
          | { type: 'image'; source: { type: 'base64'; media_type: ImageMime; data: string } }
          | { type: 'document'; source: { type: 'base64'; media_type: PdfMime; data: string } }
        > = []
        for (const f of validFiles.filter((i) => i.isNew)) {
          const mime = fileMimeFor(f.file)
          if (!mime) continue
          try {
            const data = (await fs.readFile(join(root, f.file))).toString('base64')
            if (mime === 'application/pdf') {
              fileBlocks.push({ type: 'text', text: `Attached PDF: ${JSON.stringify(f.title)}` })
              fileBlocks.push({
                type: 'document',
                source: { type: 'base64', media_type: mime, data }
              })
            } else {
              fileBlocks.push({ type: 'text', text: `Attached image: ${JSON.stringify(f.title)}` })
              fileBlocks.push({ type: 'image', source: { type: 'base64', media_type: mime, data } })
            }
          } catch {
            // unreadable — it stays listed in the system prompt; the model can say so
          }
        }

        // String prompts can't carry image/document blocks — when this turn
        // injects files, hand the SDK a one-message input stream instead.
        const promptInput =
          fileBlocks.length > 0
            ? (async function* (): AsyncGenerator<SDKUserMessage> {
                yield {
                  type: 'user',
                  message: {
                    role: 'user',
                    content: [...fileBlocks, { type: 'text', text: prompt }]
                  },
                  parent_tool_use_id: null,
                  session_id: '' // stamped by the SDK
                }
              })()
            : prompt

        const turn = query({
          prompt: promptInput,
          options: {
            cwd: root,
            model: turnModel,
            resume: forkFrom?.sessionId ?? sessionId,
            // Forking resumes the parent transcript truncated at the anchor message
            // under a NEW session id. The prefix is byte-identical, so the first
            // forked turn rides the parent's prompt cache.
            ...(forkFrom ? { forkSession: true, resumeSessionAt: forkFrom.messageUuid } : {}),
            systemPrompt: {
              type: 'preset',
              preset: 'claude_code',
              ...(systemAppend ? { append: systemAppend } : {})
            },
            ...(research
              ? {
                  agents: { researcher: RESEARCHER_DEF },
                  // Pre-approved so a research turn doesn't spam permission
                  // prompts; everything else still routes through canUseTool.
                  allowedTools: ['Agent', 'WebSearch', 'WebFetch'],
                  forwardSubagentText: true
                }
              : {}),
            settingSources: ['project'], // required or CLAUDE.md is not loaded
            // Notes stay in default mode so every edit routes through canUseTool,
            // where it's checked against the note's own file.
            permissionMode: notePath ? 'default' : 'acceptEdits',
            includePartialMessages: true,
            // Tools outside acceptEdits' auto-approval (WebSearch, Bash, …) land
            // here. Without this callback the SDK silently auto-denies them.
            canUseTool: async (toolName, input, { signal, title }) => {
              if (notePath && EDIT_TOOLS.has(toolName)) {
                const target =
                  typeof input.file_path === 'string' ? resolve(root, input.file_path) : null
                return target === resolve(notePath)
                  ? { behavior: 'allow', updatedInput: input }
                  : {
                      behavior: 'deny',
                      message: `This session may only edit the note file at ${notePath}.`
                    }
              }
              // Global auto-allows answer without a prompt. (The note-file
              // guard above still wins for note sessions' edit tools.)
              if (autoAllowed(toolName)) return { behavior: 'allow', updatedInput: input }
              // Connecting a link node IS consent to fetch it — the system
              // prompt told the model to WebFetch the page, so prompting here
              // would make the feature feel broken. Same-origin (not just the
              // exact URL) so redirects and normalized variants stay quiet;
              // fetches anywhere else still prompt below.
              if (toolName === 'WebFetch' && typeof input.url === 'string') {
                const origin = originOf(input.url)
                if (origin && validLinks.some((l) => originOf(l.url) === origin))
                  return { behavior: 'allow', updatedInput: input }
              }
              const requestId = randomUUID()
              const allow = await new Promise<boolean>((resolveVerdict) => {
                if (wc.isDestroyed()) {
                  resolveVerdict(false)
                  return
                }
                pendingPermissions.set(requestId, { toolName, resolve: resolveVerdict })
                signal.addEventListener('abort', () => resolveVerdict(false), { once: true })
                emit({
                  nodeId,
                  type: 'permission',
                  request: { requestId, toolName, ...(title ? { title } : {}), input }
                })
              })
              pendingPermissions.delete(requestId)
              emit({ nodeId, type: 'permission-resolved', requestId })
              return allow
                ? { behavior: 'allow', updatedInput: input }
                : { behavior: 'deny', message: 'The user declined this tool use.' }
            }
          }
        })

        // resumeSessionAt anchors on assistant-message uuids — remember the turn's last.
        let lastAssistantUuid: string | undefined
        // Last note content mirrored to the renderer — only emit real changes.
        let mirroredNote: string | undefined

        for await (const msg of turn) {
          // Verbose trace while research mode is young: every non-delta message,
          // with its subagent parentage and content block shapes.
          if (research && msg.type !== 'stream_event') {
            const parent = 'parent_tool_use_id' in msg ? msg.parent_tool_use_id : undefined
            const blocks =
              (msg.type === 'assistant' || msg.type === 'user') &&
              Array.isArray(msg.message.content)
                ? msg.message.content
                    .map((b) =>
                      b.type === 'tool_use'
                        ? `tool_use:${b.name}`
                        : b.type === 'tool_result'
                          ? `tool_result:${b.tool_use_id.slice(0, 12)}`
                          : b.type
                    )
                    .join(',')
                : ''
            console.log(
              `[research] msg=${msg.type}${'subtype' in msg ? `/${msg.subtype}` : ''}` +
                `${parent !== undefined ? ` parent=${parent ? parent.slice(0, 12) : 'null'}` : ''}` +
                `${blocks ? ` blocks=[${blocks}]` : ''}`
            )
          }
          if (msg.type === 'system' && msg.subtype === 'init') {
            emit({ nodeId, type: 'session', sessionId: msg.session_id })
          } else if (msg.type === 'user' && notePath) {
            // A tool just returned — if it changed the note, stream the fresh content.
            const content = await readTextIfExists(notePath)
            if (content !== mirroredNote) {
              mirroredNote = content
              emit({ nodeId, type: 'note-content', content })
            }
          } else if (msg.type === 'user' && research && msg.parent_tool_use_id === null) {
            // A researcher's report came back as the Agent tool's result.
            const content = msg.message.content
            if (Array.isArray(content)) {
              for (const block of content) {
                if (block.type === 'tool_result') {
                  emit({ nodeId, type: 'childDone', toolUseId: block.tool_use_id })
                }
              }
            }
          } else if (msg.type === 'assistant' && msg.parent_tool_use_id === null) {
            lastAssistantUuid = msg.uuid
            if (research) {
              // Spawns surface as Agent tool calls in the lead's own messages —
              // the complete message lands before the subagent starts, so 'spawn'
              // always precedes its first 'childDelta'.
              for (const block of msg.message.content) {
                if (
                  block.type === 'tool_use' &&
                  (block.name === 'Agent' || block.name === 'Task')
                ) {
                  const input = block.input as { description?: string }
                  emit({
                    nodeId,
                    type: 'spawn',
                    toolUseId: block.id,
                    description: input.description ?? 'Researcher'
                  })
                }
              }
            }
          } else if (msg.type === 'assistant' && research && msg.parent_tool_use_id) {
            // Researchers don't stream — the SDK forwards their turns as complete
            // assistant messages (forwardSubagentText). Mirror each text block
            // into the child node as it lands.
            for (const block of msg.message.content) {
              if (block.type === 'text' && block.text) {
                emit({
                  nodeId,
                  type: 'childDelta',
                  toolUseId: msg.parent_tool_use_id,
                  text: block.text + '\n\n'
                })
              }
            }
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
            const u = msg.usage
            console.log(
              `[turn] node=${nodeId.slice(0, 8)} session=${msg.session_id.slice(0, 8)}` +
                `${forkFrom ? ` fork-of=${forkFrom.sessionId.slice(0, 8)}@${forkFrom.messageUuid.slice(0, 8)}` : ''}` +
                ` in=${u.input_tokens} cache_read=${u.cache_read_input_tokens}` +
                ` cache_create=${u.cache_creation_input_tokens} out=${u.output_tokens}` +
                ` cost=$${msg.total_cost_usd.toFixed(4)}`
            )
            let note: { content: string } | undefined
            if (notePath) {
              note = { content: await readTextIfExists(notePath) }
            }
            emit({
              nodeId,
              type: 'done',
              ok: msg.subtype === 'success',
              ...(lastAssistantUuid ? { messageUuid: lastAssistantUuid } : {}),
              usage: {
                inputTokens: msg.usage.input_tokens,
                outputTokens: msg.usage.output_tokens,
                cacheReadTokens: msg.usage.cache_read_input_tokens,
                cacheCreationTokens: msg.usage.cache_creation_input_tokens,
                costUsd: msg.total_cost_usd
              },
              ...(note ? { note } : {}),
              ...(msg.subtype !== 'success' ? { error: msg.subtype } : {})
            })
          }
        }
      } catch (err) {
        // A turn that died mid-edit may have changed the note — mirror whatever
        // landed so the renderer isn't left stale.
        let note: { content: string } | undefined
        if (notePath) {
          note = { content: await readTextIfExists(notePath) }
        }
        emit({ nodeId, type: 'done', ok: false, error: String(err), ...(note ? { note } : {}) })
      }
    }
  )
}

function registerNoteIpc(): void {
  // A fresh note claims the first free "Untitled" filename at the folder root.
  ipcMain.handle('note:create', async (_event, nodeId: string): Promise<void> => {
    const root = folderRoot
    if (!root || !isSafeNodeId(nodeId) || noteFiles.has(nodeId)) return
    const slot = await createNoteFile(root, 'Untitled')
    noteFiles.set(nodeId, slot.file)
  })

  // Title committed — rename the file to match. Returns the title actually
  // used (sanitized, suffixed if taken) so the renderer can adopt it.
  ipcMain.handle(
    'note:rename',
    async (_event, nodeId: string, title: string): Promise<{ title: string } | null> => {
      const root = folderRoot
      const oldRel = root && isSafeNodeId(nodeId) ? noteFiles.get(nodeId) : undefined
      if (!root || !oldRel) return null
      const wanted = sanitizeTitle(title)
      if (!wanted) return null // blank title: keep the current file
      if (`${wanted}.md` === oldRel) return { title: wanted }
      try {
        const slot = await moveNoteFile(root, oldRel, wanted)
        noteFiles.set(nodeId, slot.file)
        return { title: slot.title }
      } catch {
        return null // file vanished or rename raced — keep the old name
      }
    }
  )

  // Autosave of the live note content (the renderer debounces keystrokes).
  ipcMain.handle('note:save', async (_event, nodeId: string, content: string): Promise<void> => {
    const path = folderRoot && isSafeNodeId(nodeId) ? notePathFor(folderRoot, nodeId) : null
    if (path) await fs.writeFile(path, content)
  })

  ipcMain.handle('note:delete', async (_event, nodeId: string): Promise<void> => {
    const root = folderRoot
    if (!root || !isSafeNodeId(nodeId)) return
    const path = notePathFor(root, nodeId)
    noteFiles.delete(nodeId)
    const doomed = [
      ...(path ? [path] : []),
      legacyNoteFileFor(root, nodeId), // pre-migration leftovers, if any
      legacyNoteVersionsFileFor(root, nodeId)
    ]
    for (const file of doomed) {
      try {
        await fs.unlink(file)
      } catch {
        // never existed
      }
    }
  })
}

// Layout/metadata only — transcripts and note bodies live in their own files.
// Note filenames come from the main process's map, not the renderer's doc.
async function writeCanvasFile(root: string, doc: CanvasDoc): Promise<void> {
  const dir = join(root, '.canvas')
  await fs.mkdir(dir, { recursive: true })
  const slim = {
    ...doc,
    nodes: doc.nodes.map((node) => {
      const copy = { ...node }
      delete copy.messages
      delete copy.content
      delete copy.file
      delete copy.dataUrl
      const file =
        node.kind === 'note'
          ? noteFiles.get(node.id)
          : node.kind === 'file' && node.file && isSafeFileRel(node.file)
            ? node.file
            : undefined
      if (file) copy.file = file
      return copy
    })
  }
  await fs.writeFile(join(dir, 'canvas.json'), JSON.stringify(slim, null, 2))
}

function registerCanvasIpc(): void {
  ipcMain.handle('canvas:load', async (): Promise<CanvasDoc | null> => {
    const root = folderRoot
    if (!root) return null
    noteFiles.clear()
    try {
      const doc: CanvasDoc = JSON.parse(await fs.readFile(canvasFileFor(root), 'utf8'))
      // One-time migration: notes that predate title-named files move from
      // .canvas/notes/<id>.md to "<title>.md" at the folder root.
      let migrated = false
      for (const node of doc.nodes) {
        if (node.kind !== 'note' || !isSafeNodeId(node.id)) continue
        if (node.file && isSafeNoteFile(node.file)) {
          noteFiles.set(node.id, node.file)
          continue
        }
        const legacyRel = join('.canvas', 'notes', `${node.id}.md`)
        let slot: { title: string; file: string }
        try {
          await fs.access(join(root, legacyRel))
          slot = await moveNoteFile(root, legacyRel, node.title)
        } catch {
          slot = await createNoteFile(root, node.title)
        }
        noteFiles.set(node.id, slot.file)
        node.file = slot.file
        // collision or sanitization may have adjusted a non-empty title
        if (node.title) node.title = slot.title
        migrated = true
      }
      if (migrated) await writeCanvasFile(root, doc)
      // Nodes that predate updatedAt borrow their backing file's mtime so
      // the sidebar's recency order is right from the first load; the next
      // canvas save makes the stamp durable.
      const mtimeOf = async (path: string): Promise<number | undefined> => {
        try {
          return Math.round((await fs.stat(path)).mtimeMs)
        } catch {
          return undefined
        }
      }
      // Transcripts and note contents live one file per node — rejoin them.
      await Promise.all(
        doc.nodes.map(async (node) => {
          if (!isSafeNodeId(node.id)) return
          if (node.kind === 'link') return // the URL rides canvas.json itself
          if (node.kind === 'file') {
            if (node.file && isSafeFileRel(node.file)) {
              node.dataUrl = await imageDataUrl(root, node.file)
            }
            return
          }
          if (node.kind === 'note') {
            const path = notePathFor(root, node.id)
            node.content = path ? await readTextIfExists(path) : ''
            if (node.updatedAt == null && path) node.updatedAt = await mtimeOf(path)
            return
          }
          try {
            const thread: ThreadDoc = JSON.parse(
              await fs.readFile(threadFileFor(root, node.id), 'utf8')
            )
            node.messages = thread.messages
            if (node.updatedAt == null) {
              node.updatedAt = await mtimeOf(threadFileFor(root, node.id))
            }
          } catch {
            // no transcript yet
          }
        })
      )
      return doc
    } catch {
      return null
    }
  })

  ipcMain.handle('canvas:save', async (_event, doc: CanvasDoc): Promise<void> => {
    if (!folderRoot) return
    await writeCanvasFile(folderRoot, doc)
  })

  ipcMain.handle(
    'canvas:saveThread',
    async (_event, nodeId: string, messages: PersistedMessage[]): Promise<void> => {
      if (!folderRoot || !isSafeNodeId(nodeId)) return
      await fs.mkdir(threadsDirFor(folderRoot), { recursive: true })
      const thread: ThreadDoc = { version: 1, messages }
      await fs.writeFile(threadFileFor(folderRoot, nodeId), JSON.stringify(thread, null, 2))
    }
  )

  ipcMain.handle('canvas:deleteThread', async (_event, nodeId: string): Promise<void> => {
    if (!folderRoot || !isSafeNodeId(nodeId)) return
    try {
      await fs.unlink(threadFileFor(folderRoot, nodeId))
    } catch {
      // never had a transcript
    }
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
      sandbox: false,
      // tab nodes embed web pages in <webview> guests (hardened below in
      // the app-wide web-contents-created hook)
      webviewTag: true
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
      contents.setWindowOpenHandler(({ url }) => {
        if (/^https?:\/\//i.test(url)) {
          // A tab node is one tab on purpose: anything its page tries to pop
          // open (target=_blank, window.open) navigates that tab's own guest
          // instead. Any guest outside the browse partition (none today)
          // hands pop-opens to the system browser. fromPartition returns the
          // same Session object for the same name, so identity comparison
          // is sound.
          if (contents.session === session.fromPartition(BROWSE_PARTITION)) {
            void contents.loadURL(url)
          } else {
            void shell.openExternal(url)
          }
        }
        return { action: 'deny' }
      })
    }
  })

  loadDotEnv()

  // Decide auth before any SDK call: stored subscription token beats .env key.
  envApiKey = process.env.ANTHROPIC_API_KEY
  oauthToken = await readStoredToken()
  applyAuthEnv()

  permissionSettings = await readPermissionSettings()

  // Reopen the folder from last time if it still exists.
  const settings = await readSettings()
  if (settings.current && (await dirExists(settings.current))) folderRoot = settings.current

  registerCanvasIpc()
  registerNoteIpc()
  registerFileIpc()
  registerThreadIpc()
  registerFolderIpc()
  registerAuthIpc()
  registerPermissionSettingsIpc()

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
