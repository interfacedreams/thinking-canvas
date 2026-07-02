import { ipcMain } from 'electron'
import { promises as fs } from 'fs'
import { join, resolve } from 'path'
import type { NoteDoc, NoteVersion } from '../shared/types'
import {
  CLAUDE_MD_FILE,
  CLAUDE_MD_ID,
  clipFileFor,
  clipsDirFor,
  getFolderRoot,
  isSafeFileRel,
  isSafeNodeId,
  legacyNoteFileFor,
  memoryFileFor,
  noteMetaDirFor,
  noteVersionsFileFor,
  readTextIfExists,
  sanitizeTitle
} from './paths'

// --- Note files ---------------------------------------------------------
// A note's live content is a title-named markdown file at the folder root
// ("Auth ideas.md"). The id→filename map is the authority: rebuilt from
// canvas.json on load, mutated by create/rename/delete, and injected back
// into canvas.json on save.
export const noteFiles = new Map<string, string>()

export const notePathFor = (root: string, nodeId: string): string | null => {
  const file = noteFiles.get(nodeId)
  return file ? join(root, file) : null
}

// Reverse of notePathFor: which note node (if any) owns this absolute path —
// used to spot when a chat's Edit tool lands on a note file (memory gardening).
export const noteIdForPath = (root: string, absPath: string): string | null => {
  for (const [id, file] of noteFiles) {
    if (resolve(root, file) === absPath) return id
  }
  return null
}

/**
 * First free title at the folder root: "Foo", "Foo 2", … Checked against the
 * filesystem itself (APFS is case-insensitive, so this doubles as the
 * case-insensitive uniqueness check) — a note never clobbers any existing
 * file, the folder's own markdown included. `keep` is the note's current
 * filename, which always counts as free (renaming to yourself is a no-op).
 */
export async function allocateNoteFile(
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
export async function createNoteFile(
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
export async function moveNoteFile(
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

/** Create an empty CLAUDE.md at the root if none exists (never clobbers an
 *  existing one — `wx` fails silently when it's already there). */
export async function ensureClaudeMdFile(root: string): Promise<void> {
  try {
    await fs.writeFile(join(root, CLAUDE_MD_FILE), '', { flag: 'wx' })
  } catch {
    // already exists — keep its contents
  }
}

// --- Note versions ------------------------------------------------------
// A note's history lives beside it as a JSON sidecar keyed by node id. The
// live content is always the .md file; each entry here is a prior state kept
// when a version boundary was crossed.

export async function readNoteVersions(root: string, nodeId: string): Promise<NoteVersion[]> {
  try {
    const doc: NoteDoc = JSON.parse(await fs.readFile(noteVersionsFileFor(root, nodeId), 'utf8'))
    return Array.isArray(doc.versions) ? doc.versions : []
  } catch {
    return []
  }
}

export async function writeNoteVersions(
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
 * the latest stored version. Called with 'user' before an AI turn (so a note's
 * current human-authored content becomes its own version, never lost) and
 * 'ai' after one (so the agent's result is preserved too). A first AI write of
 * an empty note creates no 'user' version — there was nothing to keep.
 */
export async function snapshotNote(
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

export function registerNoteIpc(): void {
  // A fresh note claims the first free "Untitled" filename at the folder root.
  ipcMain.handle('note:create', async (_event, nodeId: string): Promise<void> => {
    const root = getFolderRoot()
    if (!root || !isSafeNodeId(nodeId) || noteFiles.has(nodeId)) return
    // The CLAUDE.md node is hard-mapped to the root file, never an "Untitled".
    if (nodeId === CLAUDE_MD_ID) {
      noteFiles.set(CLAUDE_MD_ID, CLAUDE_MD_FILE)
      await ensureClaudeMdFile(root)
      return
    }
    const slot = await createNoteFile(root, 'Untitled')
    noteFiles.set(nodeId, slot.file)
  })

  // Title committed — rename the file to match. Returns the title actually
  // used (sanitized, suffixed if taken) so the renderer can adopt it.
  ipcMain.handle(
    'note:rename',
    async (_event, nodeId: string, title: string): Promise<{ title: string } | null> => {
      const root = getFolderRoot()
      if (nodeId === CLAUDE_MD_ID) return null // CLAUDE.md's filename is fixed
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
    const root = getFolderRoot()
    const path = root && isSafeNodeId(nodeId) ? notePathFor(root, nodeId) : null
    if (path) await fs.writeFile(path, content)
  })

  // The generated project memory index, for the Memory legend's read-only
  // viewer. Empty string when nothing is pinned (no file).
  ipcMain.handle('note:readMemory', (): Promise<string> => {
    const root = getFolderRoot()
    return root ? readTextIfExists(memoryFileFor(root)) : Promise.resolve('')
  })

  // Make an old version the live content again. The current content is
  // snapshotted first (a 'user' version), so a restore never destroys
  // anything — it only brings a past state back to the front.
  ipcMain.handle(
    'note:restore',
    async (
      _event,
      nodeId: string,
      index: number
    ): Promise<{ content: string; versions: NoteVersion[] } | null> => {
      const root = getFolderRoot()
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
    const root = getFolderRoot()
    if (!root || !isSafeNodeId(nodeId) || nodeId === CLAUDE_MD_ID) return // never unlink CLAUDE.md
    const path = notePathFor(root, nodeId)
    noteFiles.delete(nodeId)
    const doomed = [
      ...(path ? [path] : []),
      legacyNoteFileFor(root, nodeId), // pre-migration leftovers, if any
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

  // Delete a file card's backing file from the folder. Used when a media card is
  // removed from the canvas — the card and the file go together (mirrors how a
  // note delete unlinks its .md). Path-guarded so it can only touch the folder.
  ipcMain.handle('file:delete', async (_event, rel: string): Promise<void> => {
    const root = getFolderRoot()
    if (!root || typeof rel !== 'string' || !isSafeFileRel(rel)) return
    try {
      await fs.unlink(join(root, rel))
    } catch {
      // already gone or never on disk (e.g. a preview-only paste)
    }
  })

  // Save a pinned link's clipped page. The renderer does the extraction (only it
  // can reach the live <webview> guest where Defuddle runs), then hands the
  // markdown here to write under .canvas/clips. A small provenance header makes
  // the file self-explanatory when the agent — or the user — opens it.
  ipcMain.handle(
    'link:clip',
    async (
      _event,
      nodeId: string,
      payload: { title?: string; url: string; markdown: string }
    ): Promise<boolean> => {
      const root = getFolderRoot()
      if (!root || !isSafeNodeId(nodeId)) return false
      const { title, url, markdown } = payload ?? {}
      if (typeof url !== 'string' || typeof markdown !== 'string' || !markdown.trim()) return false
      try {
        await fs.mkdir(clipsDirFor(root), { recursive: true })
        const header = `# ${title?.trim() || url}\n\n> Clipped from ${url}\n\n---\n\n`
        await fs.writeFile(clipFileFor(root, nodeId), header + markdown.trim() + '\n')
        return true
      } catch {
        return false
      }
    }
  )

  // Drop a link's clip — on unpin, or when the node is deleted.
  ipcMain.handle('link:unclip', async (_event, nodeId: string): Promise<void> => {
    const root = getFolderRoot()
    if (!root || !isSafeNodeId(nodeId)) return
    try {
      await fs.unlink(clipFileFor(root, nodeId))
    } catch {
      // never clipped
    }
  })

  // Save a pinned chat's transcript. Like a link clip, a chat has no file of its
  // own to Read — its messages live in the renderer — so memory snapshots the
  // conversation to a hidden markdown file under .canvas/clips that the agent
  // opens on demand. The renderer builds the transcript and re-clips as the chat
  // grows; the short index blurb is generated separately (note:describe).
  ipcMain.handle(
    'chat:clipMemory',
    async (
      _event,
      nodeId: string,
      payload: { title?: string; transcript: string }
    ): Promise<boolean> => {
      const root = getFolderRoot()
      if (!root || !isSafeNodeId(nodeId)) return false
      const { title, transcript } = payload ?? {}
      if (typeof transcript !== 'string' || !transcript.trim()) return false
      try {
        await fs.mkdir(clipsDirFor(root), { recursive: true })
        const header = `# ${title?.trim() || 'Chat'}\n\n> Saved chat transcript\n\n---\n\n`
        await fs.writeFile(clipFileFor(root, nodeId), header + transcript.trim() + '\n')
        return true
      } catch {
        return false
      }
    }
  )

  // Drop a chat's transcript clip — on unpin, or when the node is deleted.
  ipcMain.handle('chat:unclipMemory', async (_event, nodeId: string): Promise<void> => {
    const root = getFolderRoot()
    if (!root || !isSafeNodeId(nodeId)) return
    try {
      await fs.unlink(clipFileFor(root, nodeId))
    } catch {
      // never clipped
    }
  })
}
