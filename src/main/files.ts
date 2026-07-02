import { BrowserWindow, clipboard, dialog, ipcMain } from 'electron'
import { promises as fs, constants as fsConstants } from 'fs'
import { tmpdir } from 'os'
import { basename, extname, isAbsolute, join, relative, resolve } from 'path'
import type { ChosenFile } from '../shared/types'
import { getFolderRoot, isSafeFileRel, sanitizeTitle } from './paths'

// --- File nodes -----------------------------------------------------------
// A file node references an image or PDF inside the folder by relative path.
// Picking a file outside the folder copies it to the root; one already inside
// is referenced where it sits. Deleting a node never deletes the file.

export type ImageMime = 'image/png' | 'image/jpeg'
export type PdfMime = 'application/pdf'
export type FileMime = ImageMime | PdfMime
export const FILE_MIME: Record<string, FileMime> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  pdf: 'application/pdf'
}

export const fileMimeFor = (file: string): FileMime | null =>
  FILE_MIME[extname(file).slice(1).toLowerCase()] ?? null

export const imageMimeFor = (file: string): ImageMime | null => {
  const mime = fileMimeFor(file)
  return mime && mime !== 'application/pdf' ? mime : null
}

// The API caps the whole request at 32 MB, and base64 inflates by a third —
// past this a PDF can't reach the model, so refuse it at pick time.
export const MAX_PDF_BYTES = 20 * 1024 * 1024

// Link-node URLs come from the renderer's own normalizer, but re-check here
// since they steer an auto-approved WebFetch.
export const isHttpUrl = (url: string): boolean => {
  try {
    const u = new URL(url)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

/** The URL's origin, or null if unparsable. */
export const originOf = (url: string): string | null => {
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}

export async function imageDataUrl(root: string, rel: string): Promise<string | undefined> {
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
export async function chosenFileFor(path: string): Promise<ChosenFile | null> {
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

export function registerFileIpc(): void {
  // Pick an image or PDF via the open dialog.
  ipcMain.handle('file:choose', async (event): Promise<ChosenFile | null> => {
    if (!getFolderRoot()) return null
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
    if (!getFolderRoot() || typeof path !== 'string' || !isAbsolute(path)) return null
    return chosenFileFor(path)
  })

  // A photo on the clipboard (a screenshot, an image copied out of a
  // browser) — staged to a temp file so the regular attach flow can copy it
  // into the folder under a free name, exactly like a picked or dropped one.
  ipcMain.handle('file:fromClipboard', async (): Promise<ChosenFile | null> => {
    if (!getFolderRoot()) return null
    const image = clipboard.readImage()
    if (image.isEmpty()) return null
    try {
      const png = image.toPNG()
      const dir = await fs.mkdtemp(join(tmpdir(), 'thinking-canvas-paste-'))
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
    const root = getFolderRoot()
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
      const root = getFolderRoot()
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
