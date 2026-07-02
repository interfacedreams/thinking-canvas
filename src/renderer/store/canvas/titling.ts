import type { CanvasNode } from './model'
import { useCanvasStore } from './store'

// Fallback title from a block of text — the first non-empty line, stripped of
// leading markdown heading/bullet markers and capped. Used when the one-shot
// title turn fails, so a finished node never sits on "…" forever.
export function titleFromText(text: string): string {
  const line =
    text
      .split('\n')
      .map((l) => l.trim())
      .find(Boolean) ?? ''
  return line
    .replace(/^#+\s*/, '')
    .replace(/^[-*+]\s+/, '')
    .slice(0, 60)
    .trim()
}

// Name a node in the background: ask Haiku for a concise title from `source`
// (a chat's first user message at send time, or a note's content once its turn
// lands) and install it — unless the user has named the node in the meantime,
// whose title always wins. A failed turn falls back to `fallback`; for notes
// the file is renamed to match.
export function generateTitle(
  nodeId: string,
  source: string,
  fallback: string,
  isNoteNode: boolean
): void {
  // Install the first answer we get and ignore the rest — the title turn might
  // resolve, reject, or hang (a stranded Haiku query would otherwise leave the
  // node on its "…" placeholder forever), so a timeout backs it with `fallback`.
  // Mark the note as awaiting its title so the header shows the pulsing "…"
  // only while this turn is actually pending — not for every unnamed note.
  const setPending = (pending: boolean): void => {
    if (!isNoteNode) return
    useCanvasStore.setState((s) => ({
      nodes: s.nodes.map((n) =>
        n.id === nodeId ? ({ ...n, data: { ...n.data, titlePending: pending } } as CanvasNode) : n
      )
    }))
  }
  setPending(true)
  let done = false
  const install = (title: string | null): void => {
    if (done) return
    done = true
    setPending(false)
    const next = title || fallback
    if (!next) return
    const cur = useCanvasStore.getState().nodes.find((n) => n.id === nodeId)
    if (!cur || cur.data.title) return // user renamed it first — their title wins
    useCanvasStore.getState().setTitle(nodeId, next)
    if (isNoteNode) void useCanvasStore.getState().commitNoteTitle(nodeId)
  }
  window.api.thread.title(source).then(install, () => install(null))
  setTimeout(() => install(null), 15000)
}
