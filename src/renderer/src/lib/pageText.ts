// The full build, not the core one: only it honors `markdown: true`
// (the core build silently returns HTML).
import Defuddle from 'defuddle/full'

// Reading a tab's page for the model. The live <webview> guest already
// rendered the page — JS challenges run, bot walls passed, SPAs hydrated — so
// the rendered DOM is the page the user sees, where a plain fetch of the same
// URL may get nothing (e.g. HUMAN-protected sites answer non-browsers with an
// empty 202). The guest hands over its HTML; Defuddle (the Obsidian Web
// Clipper's extractor) trims chrome/ads and converts the article to markdown.

/** What we need from a mounted <webview> — registered by TabBrowser. */
export interface GuestView {
  executeJavaScript(code: string): Promise<unknown>
  /** Attached guests only — throws before the webview finishes attaching. */
  getWebContentsId?(): number
}

// Live guests by link-node id. A minimized tab has no guest (the body
// unmounts), so it has no entry — its link falls back to WebFetch in main.
const guests = new Map<string, GuestView>()

export function registerGuest(id: string, view: GuestView): void {
  guests.set(id, view)
}

export function unregisterGuest(id: string, view: GuestView): void {
  if (guests.get(id) === view) guests.delete(id)
}

/**
 * The guest's webContents id, for main-process control (computer use), or null
 * when the tab has no live, attached guest — a minimized tab unmounts its
 * guest, and a freshly mounted one hasn't attached yet.
 */
export function guestWebContentsId(nodeId: string): number | null {
  const guest = guests.get(nodeId)
  if (!guest?.getWebContentsId) return null
  try {
    return guest.getWebContentsId()
  } catch {
    return null // not attached yet
  }
}

// A page rides the system prompt every turn — keep one tab from drowning it.
const MAX_PAGE_CHARS = 80_000

// A hung or busy guest must not stall the send; past this the link just
// falls back to WebFetch.
const EXTRACT_TIMEOUT_MS = 4000

/**
 * The rendered page of a link node's tab as markdown, or null when it can't
 * be read (no mounted guest, page still loading, extraction came up empty).
 * Null means "let the model WebFetch the URL instead" — never an error.
 */
export async function extractPageMarkdown(nodeId: string, url: string): Promise<string | null> {
  const guest = guests.get(nodeId)
  if (!guest) return null
  try {
    const html = await Promise.race([
      guest.executeJavaScript('document.documentElement.outerHTML'),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('extract timeout')), EXTRACT_TIMEOUT_MS)
      )
    ])
    if (typeof html !== 'string' || !html) return null
    // Parse here in the renderer rather than injecting a script bundle into
    // the guest — Defuddle takes any Document and parses synchronously.
    const doc = new DOMParser().parseFromString(html, 'text/html')
    const text = new Defuddle(doc, { url, markdown: true }).parse().content?.trim()
    if (!text) return null
    return text.length > MAX_PAGE_CHARS
      ? `${text.slice(0, MAX_PAGE_CHARS)}\n\n[Page content truncated]`
      : text
  } catch {
    return null // guest crashed, navigated mid-read, or timed out — fall back
  }
}
