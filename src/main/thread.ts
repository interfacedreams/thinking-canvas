import { ipcMain, session, webContents } from 'electron'
import { randomUUID } from 'crypto'
import { promises as fs } from 'fs'
import { isAbsolute, join, relative, resolve, sep } from 'path'
import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import {
  COMPUTER_OFF_APPEND,
  computerAppend,
  createComputerServer,
  describeComputerAction
} from './computerUse'
import {
  BROWSE_PARTITION,
  DEFAULT_EFFORT,
  DEFAULT_MODEL,
  EFFORT_OPTIONS,
  MODEL_OPTIONS,
  TITLE_MODEL
} from '../shared/types'
import type {
  EffortId,
  ModelId,
  NoteVersion,
  PermissionReply,
  ThreadEvent,
  ThreadSendArgs
} from '../shared/types'
import {
  CLAUDE_MD_FILE,
  getFolderRoot,
  isSafeFileRel,
  isSafeNodeId,
  memoryFileFor,
  readTextIfExists
} from './paths'
import {
  claimTurnNote,
  noteFiles,
  noteIdForPath,
  notePathFor,
  noteSync,
  releaseTurnNote,
  snapshotNote
} from './notes'
import { MAX_PDF_BYTES, fileMimeFor, isHttpUrl, originOf } from './files'
import type { ImageMime, PdfMime } from './files'
import { authStatus } from './auth'
import { autoAllowed, pendingPermissions } from './permissions'
import { claudeExecOpt } from './agent'

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
// Always-on framing. The claude_code preset is a coding-agent prompt: left to
// itself it surveys the working directory ("Let me explore the project
// directory…") before answering, which is wrong for a thinking canvas. This
// reframes it: the system prompt already holds the complete context, so don't
// go spelunking the filesystem, and never leave build artifacts behind.
export const BASE_APPEND =
  'This is a thinking canvas, not a code repository: you may pull in any relevant ' +
  "files from the memory index but otherwise don't explore the filesystem unless " +
  "explicitly asked. Also don't do any building or producing artifacts like HTML. " +
  'Web lookups: when the user asks you to "search", "look something up", or find ' +
  'current information, use WebSearch/WebFetch directly and answer — that is normal, ' +
  'not deep research. Deep research is a separate heavyweight workflow (multiple ' +
  'researcher subagents producing a long cited report) behind a UI toggle, and the ' +
  'toggle is OFF for this request: never start that workflow on your own. If the ' +
  'message itself asks for "deep research", still confirm before starting — ask "Do ' +
  'you want me to run a deep research workflow for this?" and wait for the answer.'

export const RESEARCH_APPEND =
  'Research mode is on for this request. Plan briefly, then spawn 2-3 researcher subagents IN PARALLEL ' +
  '(one message with multiple Agent tool calls, subagent_type: "researcher"), each covering a distinct ' +
  'angle. When they return, summarize the findings in 2-3 sentences. Only if a critical gap remains, run ' +
  'ONE follow-up round of at most 2 researchers. Then write the final report: structured markdown with ' +
  'inline numbered citations [1] and a Sources section listing every URL.'

export function registerThreadIpc(): void {
  // Chat titles: a lazy one-shot Haiku turn after a chat's first exchange.
  // Tool-less and session-less — it never touches the chat's own session.
  ipcMain.handle('thread:title', async (_event, conversation: string): Promise<string | null> => {
    const root = getFolderRoot()
    if (!root) return null
    try {
      const turn = query({
        prompt:
          'Write a title for the conversation below: usually 2-4 words, plain text, no quotes, ' +
          'no trailing punctuation. Reply with the title only.\n\n' +
          conversation,
        options: {
          cwd: root,
          ...claudeExecOpt(),
          model: TITLE_MODEL,
          maxTurns: 1,
          tools: [], // text-only turn — no tools, so no permission round-trips
          // Isolation mode: never load filesystem config (a folder's settings
          // hooks would otherwise fire on session start).
          settingSources: [],
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

  // A pinned note's index description: a one-shot Haiku turn over its content,
  // same shape as thread:title (tool-less, session-less).
  ipcMain.handle('note:describe', async (_event, content: string): Promise<string | null> => {
    const root = getFolderRoot()
    if (!root || typeof content !== 'string' || !content.trim()) return null
    try {
      const turn = query({
        prompt:
          'Summarize what this note contains in 1-3 plain sentences, for an index that ' +
          'helps decide when to open it. Describe the subject matter, not the formatting. ' +
          'No preamble, no quotes — reply with the description only.\n\n' +
          content.slice(0, 6000),
        options: {
          cwd: root,
          ...claudeExecOpt(),
          model: TITLE_MODEL,
          maxTurns: 1,
          tools: [], // text-only — no tools, no permission round-trips
          settingSources: [], // isolation mode — same reasoning as thread:title
          systemPrompt:
            'You write terse, factual index descriptions. Reply with only the description.'
        }
      })
      for await (const msg of turn) {
        if (msg.type === 'result') {
          if (msg.subtype !== 'success') return null
          const desc = msg.result.trim().replace(/\s+/g, ' ').slice(0, 320).trim()
          return desc || null
        }
      }
    } catch {
      // a failed description is just no description — the index line stays bare
    }
    return null
  })

  // A pinned image or PDF's index description: the vision counterpart of
  // note:describe. A one-shot Haiku turn that looks at the file itself (handed
  // in as an image/document block) and returns a 1-3 sentence blurb. Lazy —
  // only runs when a file is added to memory — and the result is cached in
  // canvas.json, so a reload never re-describes.
  ipcMain.handle('file:describe', async (_event, rel: string): Promise<string | null> => {
    const root = getFolderRoot()
    if (!root || typeof rel !== 'string' || !isSafeFileRel(rel)) return null
    const mime = fileMimeFor(rel)
    if (!mime) return null
    try {
      const buf = await fs.readFile(join(root, rel))
      if (mime === 'application/pdf' && buf.byteLength > MAX_PDF_BYTES) return null
      const data = buf.toString('base64')
      const isPdf = mime === 'application/pdf'
      const block = isPdf
        ? { type: 'document' as const, source: { type: 'base64' as const, media_type: mime, data } }
        : { type: 'image' as const, source: { type: 'base64' as const, media_type: mime, data } }
      const turn = query({
        prompt: (async function* (): AsyncGenerator<SDKUserMessage> {
          yield {
            type: 'user',
            message: {
              role: 'user',
              content: [
                block,
                {
                  type: 'text',
                  text:
                    `Summarize what this ${isPdf ? 'PDF' : 'image'} contains in 1-3 plain ` +
                    'sentences, for an index that helps decide when to open it. Describe the ' +
                    'subject matter, not the formatting. No preamble, no quotes — reply with ' +
                    'the description only.'
                }
              ]
            },
            parent_tool_use_id: null,
            session_id: '' // stamped by the SDK
          }
        })(),
        options: {
          cwd: root,
          ...claudeExecOpt(),
          model: TITLE_MODEL,
          maxTurns: 1,
          tools: [], // vision-only — no tools, no permission round-trips
          settingSources: [], // isolation mode — same reasoning as thread:title
          systemPrompt:
            'You write terse, factual index descriptions. Reply with only the description.'
        }
      })
      for await (const msg of turn) {
        if (msg.type === 'result') {
          if (msg.subtype !== 'success') return null
          const desc = msg.result.trim().replace(/\s+/g, ' ').slice(0, 320).trim()
          return desc || null
        }
      }
    } catch {
      // a failed description is just no description — the index line stays bare
    }
    return null
  })

  ipcMain.on('thread:permission', (_event, { requestId, allow }: PermissionReply) => {
    pendingPermissions.get(requestId)?.resolve(allow)
  })

  // File-mutating tools a note session may only point at its own file.
  const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

  // Tools that take a filesystem path. A PreToolUse hook keeps every one of
  // them inside the project folder (see the chat turn's `hooks`).
  const FILE_PATH_TOOLS = new Set(['Read', 'Glob', 'Grep', 'Edit', 'Write', 'MultiEdit'])

  // Whether a tool call clears the folder boundary. Non-file tools (WebSearch,
  // WebFetch, MCP, …) have no path to escape, so they're trivially OK; a file
  // tool is OK only when its target path resolves inside `root`. Lexical
  // containment is enough: Bash is disallowed, so there's no way to plant a
  // symlink that escapes, and new-file writes (no real path on disk yet) must
  // not throw. A file tool with no path argument (e.g. a bare Glob pattern →
  // defaults to cwd) is in-bounds by definition.
  const allowedByFolderScope = (
    root: string,
    toolName: string,
    input: Record<string, unknown>
  ): boolean => {
    if (!FILE_PATH_TOOLS.has(toolName)) return true
    const raw =
      (typeof input.file_path === 'string' && input.file_path) ||
      (typeof input.path === 'string' && input.path) ||
      null
    if (!raw) return true
    const abs = isAbsolute(raw) ? resolve(raw) : resolve(root, raw)
    const rel = relative(root, abs)
    if (rel !== '' && (rel.startsWith('..') || isAbsolute(rel))) return false
    // Agent config files are inside the boundary but never agent-touchable.
    // This app never loads them (settingSources is always []), but OTHER tools
    // do: writing .claude/settings.json could plant a command hook that runs
    // shell the next time the user opens this folder in Claude Code proper,
    // and .mcp.json may hold server credentials. Denied both directions.
    // (Grep over the whole folder can still surface .mcp.json lines in its
    // matches — don't put plaintext secrets there; use ${env:...}.)
    if (rel === '.mcp.json' || rel === '.claude' || rel.startsWith(`.claude${sep}`)) return false
    return true
  }

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
        computer,
        model,
        effort,
        contextNotes,
        contextFiles,
        contextLinks,
        outputNotes
      }: ThreadSendArgs
    ) => {
      // The renderer sends an id from MODEL_OPTIONS; anything else falls back.
      const turnModel = MODEL_OPTIONS.some((m) => m.id === model)
        ? (model as ModelId)
        : DEFAULT_MODEL
      // Likewise the effort id is validated against EFFORT_OPTIONS.
      const turnEffort = EFFORT_OPTIONS.some((e) => e.id === effort)
        ? (effort as EffortId)
        : DEFAULT_EFFORT
      const wc = event.sender
      const emit = (payload: ThreadEvent): void => {
        if (!wc.isDestroyed()) wc.send('thread:event', payload)
      }

      console.log(
        `[thread:send] node=${nodeId.slice(0, 8)} kind=${kind ?? 'chat'} research=${research === true}` +
          ` resume=${(forkFrom?.sessionId ?? sessionId)?.slice(0, 8) ?? 'fresh'}`
      )

      const root = getFolderRoot()
      if (!root) {
        emit({ nodeId, type: 'done', ok: false, error: 'No folder selected' })
        return
      }

      // No credentials → the SDK subprocess would die with a cryptic error
      // (ENOTDIR and friends) deep in its auth path. Catch it up front and let
      // the renderer prompt the user to set up a token.
      if (authStatus().method === 'none') {
        emit({
          nodeId,
          type: 'done',
          ok: false,
          needsAuth: true,
          error: 'Set up a Claude token to start chatting.'
        })
        return
      }

      const notePath = kind === 'note' && isSafeNodeId(nodeId) ? notePathFor(root, nodeId) : null
      if (kind === 'note' && !notePath) {
        emit({ nodeId, type: 'done', ok: false, error: 'Unknown note' })
        return
      }

      // Computer use: the renderer resolved a wired tab's guest webContents id.
      // Trust nothing about it — only a <webview> guest living in the app's
      // isolated browse partition may ever be driven, never the app window
      // itself (a compromised renderer could otherwise click its own UI).
      const computerWc = computer ? webContents.fromId(computer.webContentsId) : undefined
      const computerTarget =
        computer &&
        computerWc &&
        !computerWc.isDestroyed() &&
        computerWc.getType() === 'webview' &&
        computerWc.session === session.fromPartition(BROWSE_PARTITION)
          ? computer
          : null
      const computerServer = computerTarget ? createComputerServer(computerTarget) : null

      if (computer) {
        console.log(
          `[computer] node=${nodeId.slice(0, 8)} target=${computer.targetId.slice(0, 8)}` +
            ` wcId=${computer.webContentsId} url=${computer.url}` +
            ` valid=${computerTarget !== null}` +
            (computerTarget === null
              ? ` (type=${computerWc?.getType() ?? 'gone'} destroyed=${computerWc?.isDestroyed() ?? 'n/a'})`
              : '')
        )
      }

      // Notes this chat may write (output edges) — declared outside the try so
      // the catch's settle pass can see them. Each rides the system prompt for
      // reading and is editable on disk; `before` is the pre-turn content (kept
      // as a 'user' version), `mirrored` tracks the last content streamed back.
      const outputTargets: {
        id: string
        title: string
        path: string
        before: string
        mirrored: string
      }[] = []
      // Notes this turn owns (its own note, wired outputs) — claimed so the
      // disk watcher defers to the turn's mirror/settle emits, released in the
      // finally below.
      const claimedNotes: string[] = []
      const claimNote = (id: string): void => {
        claimTurnNote(id)
        claimedNotes.push(id)
      }
      // The turn is the version boundary for output notes too: any whose file
      // the agent changed becomes one 'ai' version, with its settled content
      // and fresh history mirrored to the note node. Idempotent — an unchanged
      // note is skipped. Run on both success and failure (a turn can die
      // mid-edit). Safe to call twice: the second pass finds nothing drifted.
      const settleOutputNotes = async (): Promise<void> => {
        for (const t of outputTargets) {
          const content = await readTextIfExists(t.path)
          if (content !== t.before) {
            const versions = await snapshotNote(root, t.id, 'ai')
            noteSync.set(t.id, content)
            emit({ nodeId: t.id, type: 'note-content', content, versions })
          }
        }
      }

      // Memory gardening: a chat turn may edit a pinned note that wasn't a
      // wired output target (the memory instruction invites it to fix stale
      // notes). gardenedNotes collects those, snapshotting each note's pre-edit
      // content as a 'user' version the first time it's touched. At settle they
      // version as 'ai' and reload via the guarded note-external-edit channel,
      // so an open note with unsaved edits isn't clobbered.
      const gardenedNotes = new Map<string, { path: string; before: string }>()
      const noteGardener = async (input: unknown): Promise<void> => {
        const fp = (input as { file_path?: unknown })?.file_path
        if (typeof fp !== 'string') return
        const abs = resolve(root, fp)
        const id = noteIdForPath(root, abs)
        // Skip the session's own note and any wired output note — those have
        // their own settle path.
        if (!id || id === nodeId || outputTargets.some((t) => t.id === id)) return
        if (gardenedNotes.has(id)) return
        gardenedNotes.set(id, { path: abs, before: await readTextIfExists(abs) })
        await snapshotNote(root, id, 'user')
      }
      const settleGardenedNotes = async (): Promise<void> => {
        for (const [id, t] of gardenedNotes) {
          const content = await readTextIfExists(t.path)
          if (content !== t.before) {
            const versions = await snapshotNote(root, id, 'ai')
            noteSync.set(id, content)
            emit({ nodeId: id, type: 'note-external-edit', content, versions })
          }
        }
      }

      try {
        if (notePath) {
          claimNote(nodeId)
          // The Edit tool needs a file to edit — make sure it exists.
          try {
            await fs.access(notePath)
          } catch {
            await fs.writeFile(notePath, '')
          }
          // The note's current (human-authored) content becomes its own
          // version before the AI touches it, so an edit never loses it.
          await snapshotNote(root, nodeId, 'user')
        }

        // Populate the output targets: ensure each note's file exists and
        // snapshot its pre-turn content as a 'user' version (a human edit is
        // never lost), then track it for live mirroring.
        for (const n of outputNotes ?? []) {
          if (!isSafeNodeId(n.id)) continue
          const path = notePathFor(root, n.id)
          if (!path) continue
          claimNote(n.id)
          try {
            await fs.access(path)
          } catch {
            await fs.writeFile(path, n.content ?? '')
          }
          await snapshotNote(root, n.id, 'user')
          const before = await readTextIfExists(path)
          outputTargets.push({ id: n.id, title: n.title, path, before, mirrored: before })
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
              'from disk to find this information. Just answer from what is here. Treat ' +
              'these notes as read-only reference: only edit a note’s file when the user ' +
              'directly asks you to change that note (its file path is on its block).\n\n' +
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
        // Output notes the chat may write — distinct framing from contextNotes:
        // these CAN be edited (by editing their file), the rest must not be.
        const writableAppend =
          outputTargets.length > 0
            ? 'You can edit the following note files to update them — the user wired this ' +
              'chat to write them. Their full, current contents are below, refreshed on every ' +
              'message. To change a note, edit its file with the Edit tool (or Write if it is ' +
              'empty); write each paragraph as one long line — never hard-wrap prose at a ' +
              'column width or end lines with trailing spaces; the note editor wraps to fit. ' +
              'You may also simply read them. Do not create or edit any other file unless the ' +
              'user explicitly asks.\n\n' +
              outputTargets
                .map((t) => {
                  const file = noteFiles.get(t.id)
                  const attrs =
                    `title=${JSON.stringify(t.title)}` +
                    (file ? ` file=${JSON.stringify(file)}` : '')
                  return `<note ${attrs}>\n${t.before}\n</note>`
                })
                .join('\n')
            : ''
        // The project memory index rides every chat turn (not note-editing
        // turns, which already point at one file). It's read fresh each turn,
        // so pinning a note or editing the index reaches live chats on their
        // next message. One cache miss on the prefix when it changes; cheap.
        const memoryIndex = notePath ? '' : await readTextIfExists(memoryFileFor(root))
        const memoryAppend = memoryIndex.trim()
          ? 'PROJECT MEMORY — the user has pinned resources (notes, images, PDFs and clipped ' +
            'web pages) that make up this project’s durable context. The index below lists ' +
            'each one with a ' +
            'short description and its file path (relative to the project root). When an ' +
            'entry’s description is relevant to the task, read that file with the Read tool ' +
            '(it reads images and PDFs as well as text) — you need not read them all. If the ' +
            'conversation establishes that a pinned note has become outdated or wrong, update ' +
            'that note’s file with the Edit tool and briefly tell the user what you changed. ' +
            'Never edit MEMORY.md itself — the app regenerates it from the pinned resources.' +
            '\n\n' +
            memoryIndex.trim()
          : notePath
            ? ''
            : 'PROJECT MEMORY — empty. You have no pinned context; answer directly.'
        // The folder's CLAUDE.md (the always-present instructions card), read
        // manually and appended. Deliberately NOT loaded via settingSources
        // 'project' — that flag would also load .claude/settings.json hooks
        // and .mcp.json, i.e. code execution from folder contents. Root file
        // only; nested CLAUDE.md files are ordinary notes here.
        // Read-only to every session except the card's own note session (the
        // PreToolUse hook enforces this) — told up front so the agent doesn't
        // pick CLAUDE.md as a write target and burn a turn on the denial.
        const editsClaudeMd =
          notePath !== null && resolve(notePath) === resolve(root, CLAUDE_MD_FILE)
        const claudeMd = (await readTextIfExists(join(root, CLAUDE_MD_FILE))).trim()
        const claudeMdAppend = editsClaudeMd
          ? '' // this session's whole job is editing CLAUDE.md — no notice, no echo
          : claudeMd
            ? "Project instructions from the folder's CLAUDE.md (read-only — you cannot " +
              `edit CLAUDE.md; the user edits it via its card):\n\n${claudeMd}`
            : "The folder's CLAUDE.md is read-only to you — never write to it."
        const systemAppend = [
          BASE_APPEND,
          claudeMdAppend,
          contextAppend,
          writableAppend,
          filesAppend,
          linksAppend,
          memoryAppend,
          research ? RESEARCH_APPEND : '',
          // Off-state guidance skips note-editing turns — they never browse.
          computerTarget ? computerAppend(computerTarget) : notePath ? '' : COMPUTER_OFF_APPEND
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
            // Spawn the asarUnpack'd native binary, not the in-asar path (ENOTDIR).
            ...claudeExecOpt(),
            model: turnModel,
            effort: turnEffort,
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
            // The only MCP server a turn ever gets is the app's own in-process
            // computer-use server (an SDK server object, not a spawned child) —
            // external MCP connectors are deliberately unsupported so a turn
            // can never start a process. The key is omitted when the toggle is
            // off so the SDK doesn't advertise a dormant tool.
            ...(computerServer ? { mcpServers: { computer: computerServer } } : {}),
            ...(research
              ? {
                  agents: { researcher: RESEARCHER_DEF },
                  // Pre-approved so a research turn doesn't spam permission
                  // prompts; everything else still routes through canUseTool.
                  allowedTools: [
                    'Agent',
                    'WebSearch',
                    'WebFetch',
                    ...(computerServer ? ['mcp__computer__computer'] : [])
                  ],
                  forwardSubagentText: true
                }
              : {}),
            // This is a thinking canvas, not a coding agent: it never needs to
            // run code. `tools` is an explicit ALLOWLIST of built-in tools —
            // anything unlisted (Bash, REPL, Monitor, Workflow, worktrees, …)
            // simply doesn't exist for the turn, including in subagents, so no
            // SDK upgrade can quietly widen the surface. It also turns the file
            // boundary below into a real wall (nothing can run a script that
            // opens files out of band) and means a non-coder can't be prompted
            // into approving an arbitrary command. The computer-use MCP tool is
            // unaffected — mcpServers tools ride outside this base set.
            tools: [
              'Read',
              'Glob',
              'Grep',
              'Edit',
              'Write',
              'MultiEdit',
              'WebSearch',
              'WebFetch',
              'TodoWrite',
              'Agent'
            ],
            // Belt and braces should `tools` semantics ever drift: explicitly
            // ban every tool in the current SDK that can execute code or spawn
            // a process. (Monitor takes a shell `command`; REPL runs JS;
            // EnterWorktree runs git, which can fire repo-local hooks.)
            disallowedTools: [
              'Bash',
              'BashOutput',
              'KillShell',
              'NotebookEdit',
              'REPL',
              'Workflow',
              'Monitor',
              'EnterWorktree',
              'ExitWorktree'
            ],
            // Filesystem boundary: deny any file tool whose path escapes the
            // project folder. A PreToolUse deny bypasses canUseTool and fires
            // even for auto-approved reads, so this — not canUseTool — is the
            // wall (canUseTool only ever sees a subset of file ops).
            hooks: {
              PreToolUse: [
                {
                  hooks: [
                    async (input) => {
                      if (input.hook_event_name !== 'PreToolUse') return {}
                      const ti = (input.tool_input ?? {}) as Record<string, unknown>
                      let reason: string | null = null
                      if (!allowedByFolderScope(root, input.tool_name, ti)) {
                        reason = `${input.tool_name} blocked: file paths must stay inside the project folder.`
                      } else if (
                        EDIT_TOOLS.has(input.tool_name) &&
                        typeof ti.file_path === 'string'
                      ) {
                        // CLAUDE.md rides every turn's system prompt as standing
                        // instructions, so a chat turn writing it would steer all
                        // future turns. Only the card's own note session edits it.
                        const target = resolve(root, ti.file_path)
                        if (
                          target === resolve(root, CLAUDE_MD_FILE) &&
                          (!notePath || resolve(notePath) !== target)
                        ) {
                          reason =
                            'CLAUDE.md is read-only from this session — the user edits it via its card.'
                        }
                      }
                      if (!reason) return {}
                      return {
                        hookSpecificOutput: {
                          hookEventName: 'PreToolUse',
                          permissionDecision: 'deny',
                          permissionDecisionReason: reason
                        }
                      }
                    }
                  ]
                }
              ]
            },
            // Always SDK isolation mode: no filesystem config is ever loaded,
            // so a folder's .claude/settings.json hooks and .mcp.json can never
            // execute anything — opening someone else's folder is safe without
            // a trust prompt. CLAUDE.md (which 'project' would have loaded) is
            // read manually and appended to the system prompt instead.
            settingSources: [],
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
              // Arming the computer toggle IS consent to drive the connected
              // tab — same contract as wiring a link consenting to its fetch.
              // Prompting per click would make browsing unusable.
              if (computerServer && toolName === 'mcp__computer__computer')
                return { behavior: 'allow', updatedInput: input }
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
        // The renderer funnels every text delta into one assistant bubble, so a
        // turn that emits text → tool call → more text would render the two runs
        // glued together ("…search for it.No, I don't…"). Track whether any text
        // has streamed; when a fresh text block opens after that, inject a blank
        // line so the segments stay separate paragraphs.
        let streamedAnyText = false
        // Last note content mirrored to the renderer — only emit real changes.
        let mirroredNote: string | undefined
        // Computer-use actions this turn — numbers the inline transcript chip.
        let computerSteps = 0

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
          } else if (msg.type === 'user' && (notePath || outputTargets.length > 0)) {
            // A tool just returned — if it changed the note (this session's own
            // note, or any output note the chat may write), stream the fresh
            // content to that note's node.
            if (notePath) {
              const content = await readTextIfExists(notePath)
              if (content !== mirroredNote) {
                mirroredNote = content
                noteSync.set(nodeId, content)
                emit({ nodeId, type: 'note-content', content })
              }
            }
            for (const t of outputTargets) {
              const content = await readTextIfExists(t.path)
              if (content !== t.mirrored) {
                t.mirrored = content
                noteSync.set(t.id, content)
                emit({ nodeId: t.id, type: 'note-content', content })
              }
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
            // Computer-use calls surface as a live status chip in the chat —
            // the complete assistant message lands before the tool executes,
            // so the chip always precedes the action it describes.
            if (computerTarget) {
              for (const block of msg.message.content) {
                if (block.type === 'tool_use' && block.name === 'mcp__computer__computer') {
                  computerSteps++
                  emit({
                    nodeId,
                    type: 'computer-action',
                    targetId: computerTarget.targetId,
                    text: `${describeComputerAction(block.input as Record<string, unknown>)} · step ${computerSteps}`
                  })
                }
              }
            }
            // Spot edits the chat lands on pinned/other note files before the
            // tool runs (the assistant message precedes execution), so the
            // pre-edit content can be preserved as a 'user' version.
            if (!notePath) {
              for (const block of msg.message.content) {
                if (block.type === 'tool_use' && EDIT_TOOLS.has(block.name)) {
                  await noteGardener(block.input)
                }
              }
            }
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
            if (msg.parent_tool_use_id === null) {
              if (ev.type === 'content_block_start' && ev.content_block.type === 'text') {
                // A new text block after earlier text (a tool call sat between):
                // separate them so they don't render as one run-on paragraph.
                if (streamedAnyText) emit({ nodeId, type: 'delta', text: '\n\n' })
              } else if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') {
                emit({ nodeId, type: 'delta', text: ev.delta.text })
                streamedAnyText = true
              }
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
            let note: { content: string; versions: NoteVersion[] } | undefined
            if (notePath) {
              // The turn is the version boundary: whatever edits it made, the
              // settled file becomes one 'ai' version.
              const versions = await snapshotNote(root, nodeId, 'ai')
              note = { content: await readTextIfExists(notePath), versions }
              noteSync.set(nodeId, note.content)
            }
            await settleOutputNotes()
            await settleGardenedNotes()
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
        // A turn that died mid-edit may have changed the note — version and
        // mirror whatever landed so the renderer isn't left stale.
        let note: { content: string; versions: NoteVersion[] } | undefined
        if (notePath) {
          const versions = await snapshotNote(root, nodeId, 'ai')
          note = { content: await readTextIfExists(notePath), versions }
          noteSync.set(nodeId, note.content)
        }
        await settleOutputNotes()
        await settleGardenedNotes()
        emit({ nodeId, type: 'done', ok: false, error: String(err), ...(note ? { note } : {}) })
      } finally {
        claimedNotes.forEach(releaseTurnNote)
      }
    }
  )
}
