import { app, shell, BrowserWindow, dialog, ipcMain } from 'electron'
import { randomUUID } from 'crypto'
import { promises as fs, readFileSync } from 'fs'
import { basename, join, resolve } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { query } from '@anthropic-ai/claude-agent-sdk'
import icon from '../../resources/icon.png?asset'
import { DEFAULT_MODEL, MODEL_OPTIONS } from '../shared/types'
import type {
  CanvasDoc,
  FolderState,
  ModelId,
  NoteDoc,
  NoteVersion,
  PermissionReply,
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
// Version sidecars (and pre-migration note bodies) live here, keyed by node id.
const noteMetaDirFor = (root: string): string => join(root, '.canvas', 'notes')
const legacyNoteFileFor = (root: string, nodeId: string): string =>
  join(noteMetaDirFor(root), `${nodeId}.md`)
const noteVersionsFileFor = (root: string, nodeId: string): string =>
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

async function readNoteVersions(root: string, nodeId: string): Promise<NoteVersion[]> {
  try {
    const doc: NoteDoc = JSON.parse(await fs.readFile(noteVersionsFileFor(root, nodeId), 'utf8'))
    return doc.versions
  } catch {
    return []
  }
}

async function writeNoteVersions(
  root: string,
  nodeId: string,
  versions: NoteVersion[]
): Promise<void> {
  await fs.mkdir(noteMetaDirFor(root), { recursive: true })
  const doc: NoteDoc = { version: 1, versions }
  await fs.writeFile(noteVersionsFileFor(root, nodeId), JSON.stringify(doc, null, 2))
}

/**
 * Version boundary: snapshot the note's live content if it has drifted from
 * the latest version. Called with 'user' before an AI turn (so unversioned
 * user edits become their own version) and 'ai' after one.
 */
async function snapshotNote(
  root: string,
  nodeId: string,
  author: NoteVersion['author']
): Promise<NoteVersion[]> {
  const path = notePathFor(root, nodeId)
  const content = path ? await readTextIfExists(path) : ''
  const versions = await readNoteVersions(root, nodeId)
  const last = versions[versions.length - 1]
  const drifted = last ? last.content !== content : content !== ''
  if (drifted) {
    versions.push({ content, author, at: new Date().toISOString() })
    await writeNoteVersions(root, nodeId, versions)
  }
  return versions
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
  // Permission requests in flight: requestId → resolver for the user's verdict.
  // canUseTool blocks the SDK turn until the renderer answers via thread:permission.
  const pendingPermissions = new Map<string, (allow: boolean) => void>()

  ipcMain.on('thread:permission', (_event, { requestId, allow }: PermissionReply) => {
    pendingPermissions.get(requestId)?.(allow)
  })

  // File-mutating tools a note session may only point at its own file.
  const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

  ipcMain.handle(
    'thread:send',
    async (
      event,
      { nodeId, text, sessionId, forkFrom, kind, noteTitle, research, model }: ThreadSendArgs
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
          // Unversioned user edits become their own version before the AI touches it.
          await snapshotNote(root, nodeId, 'user')
        }

        const prompt = notePath
          ? `You are connected to the markdown note "${noteTitle || 'Untitled'}" at ${notePath}. ` +
            `Apply the instruction below by editing that file directly — use the Edit tool ` +
            `(or Write if the file is empty). Never create or modify any other file. ` +
            `Keep your text reply to a sentence or two; the edits speak for themselves.` +
            `\n\nInstruction: ${text}`
          : text

        const turn = query({
          prompt,
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
              ...(research ? { append: RESEARCH_APPEND } : {})
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
              const requestId = randomUUID()
              const allow = await new Promise<boolean>((resolveVerdict) => {
                if (wc.isDestroyed()) {
                  resolveVerdict(false)
                  return
                }
                pendingPermissions.set(requestId, resolveVerdict)
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
            // The turn is the version boundary: however many edits it made, they
            // land as one snapshot.
            let note: { content: string; versions: NoteVersion[] } | undefined
            if (notePath) {
              const versions = await snapshotNote(root, nodeId, 'ai')
              note = { content: await readTextIfExists(notePath), versions }
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
        // A turn that died mid-edit may have changed the note — version whatever
        // landed so nothing is silently lost.
        let note: { content: string; versions: NoteVersion[] } | undefined
        if (notePath) {
          try {
            const versions = await snapshotNote(root, nodeId, 'ai')
            note = { content: await readTextIfExists(notePath), versions }
          } catch {
            // report the original error regardless
          }
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

  // Make an old version the live content again. Unversioned edits are
  // snapshotted first, so restoring never destroys anything.
  ipcMain.handle(
    'note:restore',
    async (
      _event,
      nodeId: string,
      index: number
    ): Promise<{ content: string; versions: NoteVersion[] } | null> => {
      const root = folderRoot
      const path = root && isSafeNodeId(nodeId) ? notePathFor(root, nodeId) : null
      if (!root || !path) return null
      const versions = await snapshotNote(root, nodeId, 'user')
      const target = versions[index]
      if (!target) return null
      await fs.writeFile(path, target.content)
      return { content: target.content, versions }
    }
  )

  ipcMain.handle('note:delete', async (_event, nodeId: string): Promise<void> => {
    const root = folderRoot
    if (!root || !isSafeNodeId(nodeId)) return
    const path = notePathFor(root, nodeId)
    noteFiles.delete(nodeId)
    const doomed = [
      ...(path ? [path] : []),
      legacyNoteFileFor(root, nodeId), // pre-migration leftover, if any
      noteVersionsFileFor(root, nodeId)
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
      delete copy.noteVersions
      delete copy.file
      const file = node.kind === 'note' ? noteFiles.get(node.id) : undefined
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
      // Transcripts and note contents live one file per node — rejoin them.
      await Promise.all(
        doc.nodes.map(async (node) => {
          if (!isSafeNodeId(node.id)) return
          if (node.kind === 'note') {
            const path = notePathFor(root, node.id)
            node.content = path ? await readTextIfExists(path) : ''
            node.noteVersions = await readNoteVersions(root, node.id)
            return
          }
          try {
            const thread: ThreadDoc = JSON.parse(
              await fs.readFile(threadFileFor(root, node.id), 'utf8')
            )
            node.messages = thread.messages
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

  // Reopen the folder from last time if it still exists.
  const settings = await readSettings()
  if (settings.current && (await dirExists(settings.current))) folderRoot = settings.current

  registerCanvasIpc()
  registerNoteIpc()
  registerThreadIpc()
  registerFolderIpc()

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
