import {
  LABEL_FRAME,
  PDF_FRAME,
  makeFileNode,
  makeLabelNode,
  makeLinkNode,
  makeNode,
  makeNoteNode,
  makeWidgetNode,
  viewportFitHeight,
  widgetFrame
} from './model'
import type { CanvasState } from './state'
import type { StoreCtx } from './helpers'

export function createFoldersSlice(
  ctx: StoreCtx
): Pick<
  CanvasState,
  | 'init'
  | 'chooseFolder'
  | 'selectFolder'
  | 'createFolder'
  | 'persistSoon'
  | 'persistThread'
  | 'load'
> {
  const {
    set,
    get,
    persist,
    persistThread,
    anyStreaming,
    flushSave,
    switchFolder,
    ensureClaudeMd
  } = ctx
  return {
    init: async () => {
      const folder = await window.api.folder.get()
      set({ folder })
      if (!folder.current) return null
      return get().load()
    },

    chooseFolder: async () => {
      if (anyStreaming()) return null
      await flushSave()
      return switchFolder(await window.api.folder.choose())
    },

    selectFolder: async (path) => {
      if (path === get().folder?.current || anyStreaming()) return null
      await flushSave()
      return switchFolder(await window.api.folder.select(path))
    },

    createFolder: async (name, parent) => {
      if (anyStreaming()) return null
      await flushSave()
      return switchFolder(await window.api.folder.create(name, parent))
    },

    persistSoon: persist,

    persistThread,

    load: async () => {
      const doc = await window.api.canvas.load()
      if (!doc) {
        // Brand-new folder, no canvas.json yet — still give it its CLAUDE.md.
        set({ loaded: true, nodes: ensureClaudeMd([]) })
        get().persistSoon()
        return null
      }
      // Heights saved on a bigger screen may not fit this one — clamp on the way in.
      const cap = viewportFitHeight(doc.viewport.zoom)
      set({
        loaded: true,
        viewport: doc.viewport,
        edges: doc.edges ?? [],
        nodes: ensureClaudeMd(
          doc.nodes.map((p) => {
            const frame = {
              id: p.id,
              width: p.width,
              ...(p.height != null && !p.minimized ? { height: Math.min(p.height, cap) } : {})
            }
            const savedHeight =
              p.minimized && p.height != null ? Math.min(p.height, cap) : undefined
            if (p.kind === 'file') {
              const isPdf = p.file?.toLowerCase().endsWith('.pdf')
              // File frames are explicit and aspect-true — no screen-fit clamp.
              // Auto-placed cards arrive with no height; a PDF with no height
              // renders every page full-inline, so fall back to the standard
              // PDF frame (width and height) when none was saved.
              const fileFrameDims =
                p.height != null && !p.minimized
                  ? { width: p.width, height: p.height }
                  : isPdf
                    ? { width: PDF_FRAME.width, height: PDF_FRAME.height }
                    : { width: p.width }
              return {
                ...makeFileNode(p.position, fileFrameDims, {
                  title: p.title,
                  color: p.color,
                  kind: isPdf ? ('pdf' as const) : ('image' as const),
                  file: p.file,
                  dataUrl: p.dataUrl,
                  ...(p.pinned ? { pinned: true } : {}),
                  ...(p.description ? { description: p.description } : {}),
                  minimized: p.minimized ?? false,
                  updatedAt: p.updatedAt,
                  ...(p.minimized && p.height != null ? { savedHeight: p.height } : {})
                }),
                id: p.id
              }
            }
            if (p.kind === 'link') {
              const node = makeLinkNode(p.position, {
                title: p.title,
                color: p.color,
                url: p.url,
                ...(p.pinned ? { pinned: true } : {}),
                ...(p.description ? { description: p.description } : {}),
                minimized: p.minimized ?? false,
                updatedAt: p.updatedAt,
                ...(p.minimized && p.height != null ? { savedHeight: p.height } : {})
              })
              return {
                ...node,
                id: p.id,
                width: p.width,
                // minimized links collapse to the title row (no explicit height)
                height: p.height != null && !p.minimized ? p.height : undefined
              }
            }
            if (p.kind === 'widget') {
              const node = makeWidgetNode(
                p.position,
                widgetFrame({ width: p.width, height: p.height }),
                {
                  title: p.title,
                  color: p.color,
                  html: p.html ?? '',
                  ...(p.pinned ? { pinned: true } : {}),
                  ...(p.description ? { description: p.description } : {}),
                  minimized: p.minimized ?? false,
                  savedHeight,
                  updatedAt: p.updatedAt
                }
              )
              return {
                ...node,
                id: p.id,
                width: p.width,
                // minimized widgets collapse to the title row (no explicit height)
                height: p.height != null && !p.minimized ? p.height : undefined
              }
            }
            if (p.kind === 'label') {
              // Label text rides `title`; its box (width/height) is explicit
              // and aspect-free — no screen-fit clamp.
              return {
                ...makeLabelNode(p.position, { title: p.title, updatedAt: p.updatedAt }),
                id: p.id,
                width: p.width,
                height: p.height ?? LABEL_FRAME.height
              }
            }
            if (p.kind === 'note') {
              return {
                ...makeNoteNode(p.position, {
                  title: p.title,
                  color: p.color,
                  content: p.content ?? '',
                  versions: p.noteVersions ?? [],
                  ...(p.pinned ? { pinned: true } : {}),
                  ...(p.description ? { description: p.description } : {}),
                  ...(p.system ? { system: p.system } : {}),
                  status: 'idle',
                  minimized: p.minimized ?? false,
                  savedHeight,
                  growthCap: cap,
                  sessionId: p.sessionId,
                  updatedAt: p.updatedAt
                }),
                ...frame
              }
            }
            return {
              ...makeNode(p.position, {
                title: p.title,
                color: p.color,
                messages: p.messages ?? [],
                status: p.title || (p.messages?.length ?? 0) > 0 ? 'idle' : 'empty',
                minimized: p.minimized ?? false,
                savedHeight,
                growthCap: cap,
                sessionId: p.sessionId,
                forkOf: p.forkOf,
                injectedImages: p.injectedImages,
                ...(p.pinned ? { pinned: true } : {}),
                ...(p.description ? { description: p.description } : {}),
                updatedAt: p.updatedAt,
                ...(p.kind === 'research' ? { kind: 'research' as const } : {})
              }),
              ...frame
            }
          })
        )
      })
      return doc.viewport
    }
  }
}
