import { isNote, viewportFitHeight } from './model'
import type { CanvasNode } from './model'
import type { CanvasState } from './state'
import type { StoreCtx } from './helpers'
import { noteSaveTimers } from './runtime'

export function createNotesSlice(
  ctx: StoreCtx
): Pick<
  CanvasState,
  | 'commitNoteTitle'
  | 'setNoteContent'
  | 'setViewVersion'
  | 'restoreVersion'
  | 'reloadExternalEdit'
  | 'sendNote'
> {
  const { set, get, patchData, persist, isClaudeMd, flushNoteSave } = ctx
  return {
    // Title editing settled — rename the note's file to match. Main may
    // adjust the title (sanitized, suffixed if taken); adopt what it used.
    commitNoteTitle: async (id) => {
      if (isClaudeMd(id)) return // its filename is fixed; never rename
      const node = get().nodes.find((n) => n.id === id)
      if (!node || !isNote(node)) return
      const res = await window.api.note.rename(id, node.data.title)
      if (res && res.title !== node.data.title) patchData(id, { title: res.title })
      persist() // canvas.json picks up the new filename from main
    },

    setNoteContent: (id, content) => {
      // Notes grow with their content the way chats grow with replies:
      // editing releases any fixed height and caps growth to the screen.
      const growthCap = viewportFitHeight(get().viewport.zoom)
      set((s) => ({
        nodes: s.nodes.map((n) =>
          n.id === id
            ? ({
                ...n,
                height: undefined,
                data: { ...n.data, content, growthCap, updatedAt: Date.now() }
              } as CanvasNode)
            : n
        )
      }))
      persist() // updatedAt must survive a reload — content itself saves via note.save below
      const timer = noteSaveTimers.get(id)
      if (timer) clearTimeout(timer)
      noteSaveTimers.set(
        id,
        setTimeout(() => {
          noteSaveTimers.delete(id)
          void window.api.note.save(id, content)
        }, 600)
      )
      // A pinned note's index blurb tracks its content (debounced inside).
      const node = get().nodes.find((n) => n.id === id)
      if (node && isNote(node) && node.data.pinned) get().scheduleDescribe(id)
    },

    setViewVersion: (id, index) => patchData(id, { viewVersion: index }),

    restoreVersion: async (id, index) => {
      const node = get().nodes.find((n) => n.id === id)
      if (!node || !isNote(node) || node.data.status === 'streaming') return
      // Any pending keystrokes must reach disk first — main snapshots the live
      // file before overwriting it, and that snapshot has to be current.
      await flushNoteSave(id)
      const res = await window.api.note.restore(id, index)
      if (res) {
        patchData(id, {
          content: res.content,
          versions: res.versions,
          viewVersion: undefined,
          updatedAt: Date.now()
        })
        persist()
        get().scheduleDescribe(id)
      }
    },

    reloadExternalEdit: (id) => {
      const node = get().nodes.find((n) => n.id === id)
      if (!node || !isNote(node) || !node.data.externalEdit) return
      patchData(id, {
        content: node.data.externalEdit.content,
        externalEdit: undefined,
        updatedAt: Date.now()
      })
      persist()
    },

    sendNote: async (id) => {
      const node = get().nodes.find((n) => n.id === id)
      if (!node || !isNote(node) || node.data.status === 'streaming') return
      const text = node.data.draft.trim()
      if (!text) return

      const growthCap = viewportFitHeight(get().viewport.zoom)
      set((s) => ({
        nodes: s.nodes.map((n) =>
          n.id === id
            ? ({
                ...n,
                // release any fixed height so the note grows with the AI's edits
                height: undefined,
                data: {
                  ...n.data,
                  draft: '',
                  status: 'streaming' as const,
                  lastReply: '',
                  growthCap,
                  viewVersion: undefined, // an editing turn always lands on the live content
                  updatedAt: Date.now()
                }
              } as CanvasNode)
            : n
        )
      }))
      // The agent reads the note from disk — the latest keystrokes must be there.
      await flushNoteSave(id)
      void window.api.thread.send({
        nodeId: id,
        text,
        sessionId: node.data.sessionId,
        model: get().model,
        effort: get().effort,
        kind: 'note',
        noteTitle: node.data.title
      })
    }
  }
}
