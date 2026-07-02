import { useToastStore } from '@renderer/ui/toastStore'
import { extractPageMarkdown } from '@renderer/features/nodes/link/pageText'
import { chatTranscript, isChat, isFile, isLink, isNote } from './model'
import type { CanvasState } from './state'
import type { StoreCtx } from './helpers'
import { describeTimers } from './runtime'

export function createMemorySlice(
  ctx: StoreCtx
): Pick<CanvasState, 'togglePin' | 'refreshChatMemory' | 'scheduleDescribe'> {
  const { get, patchData, persist, isClaudeMd } = ctx
  return {
    togglePin: (id) => {
      if (isClaudeMd(id)) return // already always-in-context; not a memory pin
      const node = get().nodes.find((n) => n.id === id)
      if (!node) return

      // Links can't be Read in place — they're a live tab, not a file. Joining
      // memory clips the rendered page (Defuddle, the same extractor a chat uses)
      // to a hidden markdown file the agent Reads on demand. The extraction lives
      // here in the renderer because only it can reach the tab's <webview> guest.
      if (isLink(node)) {
        if (node.data.pinned) {
          patchData(id, { pinned: false, description: undefined })
          persist()
          void window.api.link.unclip(id)
          return
        }
        const url = node.data.url
        if (!url) return
        // Clipping is async (extract → write → describe), so flip `pinned` NOW:
        // the button reflects it instantly and a second click reads "pinned" and
        // unpins, instead of kicking off a duplicate clip. Hold off on persist()
        // until the clip file exists, so MEMORY.md never lists a missing clip; if
        // the user unpins mid-flight, `pinned` is already false and each step
        // below bails (and cleans up a clip it may have written).
        patchData(id, { pinned: true })
        const stillPinned = (): boolean => {
          const cur = get().nodes.find((n) => n.id === id)
          return !!cur && isLink(cur) && !!cur.data.pinned
        }
        void (async () => {
          const markdown = await extractPageMarkdown(id, url)
          if (!stillPinned()) return // unpinned while extracting — nothing written yet
          if (!markdown) {
            patchData(id, { pinned: false }) // roll back the optimistic flip
            persist()
            // No live guest (tab minimized/hung) or the page wouldn't extract.
            useToastStore.getState().show('Open this page in its tab, then add it to memory')
            return
          }
          const ok = await window.api.link.clip(id, { title: node.data.title, url, markdown })
          if (!stillPinned()) {
            void window.api.link.unclip(id) // unpinned during clip — undo the file
            return
          }
          if (!ok) {
            patchData(id, { pinned: false })
            persist()
            useToastStore.getState().show('Couldn’t save this page to memory')
            return
          }
          persist() // clip exists now → MEMORY.md can list it
          // Describe from the clip we just took (text summarizer, like a note).
          const description = await window.api.note.describe(markdown)
          if (!description || !stillPinned()) return
          patchData(id, { description })
          persist()
        })()
        return
      }

      // Chats have no file of their own — like a link, joining memory snapshots
      // the transcript to a hidden clip the agent Reads on demand. Optimistic
      // flip + stillPinned guard mirror the link flow; the transcript is already
      // in hand (renderer-held messages), so there's no async extraction step.
      if (isChat(node)) {
        if (node.data.kind === 'research') return // display-only researcher transcript
        if (node.data.pinned) {
          patchData(id, { pinned: false, description: undefined })
          persist()
          void window.api.chat.unclipMemory(id)
          return
        }
        const transcript = chatTranscript(node.data.messages)
        if (!transcript.trim()) {
          useToastStore.getState().show('This chat is empty — nothing to remember yet')
          return
        }
        patchData(id, { pinned: true })
        const stillPinned = (): boolean => {
          const cur = get().nodes.find((n) => n.id === id)
          return !!cur && isChat(cur) && !!cur.data.pinned
        }
        void (async () => {
          const ok = await window.api.chat.clipMemory(id, { title: node.data.title, transcript })
          if (!stillPinned()) {
            void window.api.chat.unclipMemory(id) // unpinned during write — undo the file
            return
          }
          if (!ok) {
            patchData(id, { pinned: false })
            persist()
            useToastStore.getState().show('Couldn’t save this chat to memory')
            return
          }
          persist() // clip exists now → MEMORY.md can list it
          const description = await window.api.note.describe(transcript)
          if (!description || !stillPinned()) return
          patchData(id, { description })
          persist()
        })()
        return
      }

      // Notes and files (images/PDFs) are already on disk — just flip the flag.
      if (!isNote(node) && !isFile(node)) return
      const pinned = !node.data.pinned
      patchData(id, { pinned })
      persist() // pin state + the regenerated MEMORY.md ride the canvas save
      // First pin of a resource that has content but no blurb: describe it now
      // so the index line isn't bare. Notes describe their text; files their
      // pixels/pages.
      if (pinned && !node.data.description) {
        if (isNote(node) ? node.data.content.trim() : node.data.file) {
          get().scheduleDescribe(id)
        }
      }
    },

    refreshChatMemory: (id) => {
      const node = get().nodes.find((n) => n.id === id)
      if (!node || !isChat(node) || !node.data.pinned) return
      const transcript = chatTranscript(node.data.messages)
      if (!transcript.trim()) return
      // Keep the clip the agent Reads current with every turn — that's the full
      // content. The 1-3 sentence blurb only describes the opening of the chat
      // (describe sees the first slice), so generate it once and keep it; no need
      // to re-run Haiku on every reply.
      void window.api.chat.clipMemory(id, { title: node.data.title, transcript })
      if (!node.data.description) get().scheduleDescribe(id)
    },

    scheduleDescribe: (id) => {
      const existing = describeTimers.get(id)
      if (existing) clearTimeout(existing)
      describeTimers.set(
        id,
        setTimeout(() => {
          describeTimers.delete(id)
          const node = get().nodes.find((n) => n.id === id)
          if (!node || !node.data.pinned) return
          // The describe call differs by kind (text vs. vision), but the
          // commit is the same: cache the blurb if the node is still pinned.
          const commit = (description: string | null): void => {
            if (!description) return
            const cur = get().nodes.find((n) => n.id === id)
            // The node may have been unpinned or deleted while Haiku ran.
            if (cur && (isNote(cur) || isFile(cur) || isChat(cur)) && cur.data.pinned) {
              patchData(id, { description })
              persist()
            }
          }
          if (isNote(node)) {
            const content = node.data.content.trim()
            if (!content) return
            void window.api.note.describe(content).then(commit)
          } else if (isFile(node) && node.data.file) {
            void window.api.file.describe(node.data.file).then(commit)
          } else if (isChat(node)) {
            // Chats summarize like notes — a text turn over the transcript. The
            // describe handler caps it at 1-3 sentences, so even a long chat
            // gets a terse index line.
            const transcript = chatTranscript(node.data.messages)
            if (!transcript.trim()) return
            void window.api.note.describe(transcript).then(commit)
          }
        }, 1500)
      )
    }
  }
}
