import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, Globe, RotateCw, Search } from 'lucide-react'
import { useCanvasStore } from '../store/canvas'
import { registerGuest, unregisterGuest } from '../lib/pageText'
import { BROWSE_PARTITION } from '../../../shared/types'

// Some sites refuse to render for an unknown "Electron" browser — the guest
// announces itself as the plain Chrome this Chromium actually is.
const CLEAN_UA = navigator.userAgent.replace(/\s(?:bee[- ]claude|Electron)\/\S+/g, '')

// Where a search goes.
const SEARCH_URL = 'https://www.google.com/search?q='

// The <webview> methods the tab's toolbar drives. React's HTMLWebViewElement
// is a bare HTMLElement; Electron attaches these once the guest is attached.
interface WebviewEl extends HTMLElement {
  loadURL(url: string): Promise<void>
  getURL(): string
  reload(): void
  goBack(): void
  goForward(): void
  canGoBack(): boolean
  canGoForward(): boolean
  executeJavaScript(code: string): Promise<unknown>
}

/** One box, two jobs: a URL navigates, anything else becomes a Google search
 *  ('' only for blank input). */
function toNavigableUrl(raw: string): string {
  const t = raw.trim()
  if (!t) return ''
  try {
    if (/^https?:\/\//i.test(t)) return new URL(t).href
    // a bare domain like nuwapen.com/about — same shape canvas paste accepts
    if (!/\s/.test(t) && /^[\w-]+(\.[\w-]+)+([/?#]|$)/.test(t)) {
      return new URL(`https://${t}`).href
    }
  } catch {
    // unparsable — treat it as a search
  }
  return `${SEARCH_URL}${encodeURIComponent(t)}`
}

/**
 * A URL-less tab's body: one search-or-link box. Committing sets the node's
 * URL, which swaps this for the TabBrowser wherever the body renders (the
 * canvas card or the side panel).
 */
export function LinkSearch({ id, active }: { id: string; active: boolean }): React.JSX.Element {
  const setLinkUrl = useCanvasStore((s) => s.setLinkUrl)
  const searchRef = useRef<HTMLInputElement>(null)
  const [draft, setDraft] = useState('')

  // Type-and-Enter without an extra click: the box takes the keyboard the
  // moment the tab is born.
  useEffect(() => {
    if (active) searchRef.current?.focus()
  }, [active])

  return (
    <form
      className="flex h-full w-full items-center gap-2 px-3"
      onSubmit={(e) => {
        e.preventDefault()
        const url = toNavigableUrl(draft)
        if (url) setLinkUrl(id, url)
      }}
    >
      <Search className="h-5 w-5 shrink-0 text-(--np-deep) opacity-60" />
      <input
        ref={searchRef}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder="Search Google or paste a link"
        spellCheck={false}
        className="nodrag min-w-0 flex-1 cursor-text rounded-[10px] border border-(--np-edge) bg-white px-3 py-2 text-[15px] text-neutral-800 outline-none placeholder:text-neutral-400 focus:ring-2 focus:ring-(--np-ring)"
      />
    </form>
  )
}

const TOOL_BUTTON =
  'nodrag flex shrink-0 cursor-pointer items-center justify-center rounded-[6px] p-1 text-(--np-deep) ' +
  'transition-colors hover:bg-(--np-chip) disabled:cursor-default disabled:opacity-30 disabled:hover:bg-transparent'

// Two-finger horizontal swipe → back/forward, injected into the guest itself
// (wheel events over a webview never reach the embedder, so the host can't
// catch the gesture). Runs in the page's own world, so history.back/forward
// here is exactly the guest's own navigation. Horizontal intent only, so
// vertical scrolling is untouched; a short lock swallows the momentum tail so
// one flick navigates once. Re-injected on every dom-ready (each load resets
// the page's context); the window flag keeps it idempotent within a load.
const SWIPE_NAV_SCRIPT = `(() => {
  if (window.__beeSwipeNav) return;
  window.__beeSwipeNav = true;
  var accum = 0, reset = null, locked = false;
  var THRESHOLD = 120;
  addEventListener('wheel', function (e) {
    if (locked) return;
    if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
    accum += e.deltaX;
    clearTimeout(reset);
    reset = setTimeout(function () { accum = 0; }, 200);
    if (accum <= -THRESHOLD || accum >= THRESHOLD) {
      var back = accum < 0;
      accum = 0;
      locked = true;
      setTimeout(function () { locked = false; }, 700);
      if (back) history.back(); else history.forward();
    }
  }, { passive: true });
})();`

/**
 * The tab: an Electron <webview> guest under a slim browser toolbar. A guest
 * is its own top-level frame, so X-Frame-Options / frame-ancestors can't
 * refuse it the way they would an iframe (which is why google.com works here
 * at all), and it scrolls natively.
 *
 * All tabs share one session partition — their own persistent cookie jar,
 * logged into nothing in the app or the user's browser. Pop-opens
 * (target=_blank, window.open) navigate the same guest: one tab per card, by
 * design (main's window-open handler routes them back via the partition).
 *
 * The guest mounts once on the URL the tab was born with; from there the user
 * browses inside it (results, links, the address box), and every navigation
 * syncs back to the node's data.url — that's what a context edge hands to a
 * chat, and where the tab reopens on canvas reload. A webview can't be
 * reparented, so docking a tab into the side panel (or back) remounts the
 * guest at its current URL — scroll position and history reset by design.
 *
 * Focus-gating follows the transcript convention by other means — wheel
 * events over a guest never reach the embedder, so an unfocused card lays a
 * transparent shield over the page instead: clicks select the node (which
 * lifts the shield) and wheels bubble to the pane as a canvas pan. Focused
 * (or docked in the panel), the page gets the pointer for real.
 */
export default function TabBrowser({
  id,
  url,
  focused,
  swipeNav = false
}: {
  id: string
  url: string
  focused: boolean
  swipeNav?: boolean
}): React.JSX.Element {
  const webviewRef = useRef<HTMLWebViewElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const wv = (): WebviewEl | null => webviewRef.current as WebviewEl | null

  // The guest's src is fixed to the birth URL: navigation happens through
  // loadURL and in-page clicks, never by remounting (a remount would wipe the
  // guest's own history). data.url changing back to us is just our own sync.
  const [initialUrl] = useState(url)

  const [address, setAddress] = useState(url) // what's in the box (mid-edit)
  const [pageUrl, setPageUrl] = useState(url) // what's actually loaded
  const [canBack, setCanBack] = useState(false)
  const [canFwd, setCanFwd] = useState(false)
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)

  useEffect(() => {
    const el = wv()
    if (!el) return
    // While the guest lives, sends can read its rendered page (pageText) —
    // a minimized tab unmounts the guest, so its link falls back to WebFetch.
    registerGuest(id, el)
    const sync = (): void => {
      const current = el.getURL()
      setPageUrl(current)
      setCanBack(el.canGoBack())
      setCanFwd(el.canGoForward())
      // never clobber an address the user is mid-typing
      if (document.activeElement !== inputRef.current) setAddress(current)
      useCanvasStore.getState().syncTabUrl(id, current)
    }
    const onNavigate = (): void => {
      setFailed(null)
      sync()
    }
    const onStart = (): void => setLoading(true)
    const onStop = (): void => {
      setLoading(false)
      sync()
    }
    const onFail = (e: Event): void => {
      const ev = e as Event & { errorCode: number; errorDescription: string; isMainFrame: boolean }
      // -3 is ERR_ABORTED — routine for redirects and in-page navigations
      if (ev.isMainFrame && ev.errorCode !== -3) {
        setFailed(ev.errorDescription || `error ${ev.errorCode}`)
      }
    }
    el.addEventListener('did-navigate', onNavigate)
    el.addEventListener('did-navigate-in-page', sync)
    el.addEventListener('did-start-loading', onStart)
    el.addEventListener('did-stop-loading', onStop)
    el.addEventListener('did-fail-load', onFail)
    return () => {
      unregisterGuest(id, el)
      el.removeEventListener('did-navigate', onNavigate)
      el.removeEventListener('did-navigate-in-page', sync)
      el.removeEventListener('did-start-loading', onStart)
      el.removeEventListener('did-stop-loading', onStop)
      el.removeEventListener('did-fail-load', onFail)
    }
  }, [id])

  // Only the half-sheet panel arms swipe navigation — a canvas card leaves
  // horizontal scroll to the page. Re-inject on every dom-ready so the gesture
  // survives navigations within the tab.
  useEffect(() => {
    if (!swipeNav) return
    const el = wv()
    if (!el) return
    const inject = (): void => {
      void el.executeJavaScript(SWIPE_NAV_SCRIPT).catch(() => {})
    }
    el.addEventListener('dom-ready', inject)
    return () => el.removeEventListener('dom-ready', inject)
  }, [swipeNav])

  const go = (): void => {
    const next = toNavigableUrl(address)
    if (!next) return
    setFailed(null)
    // rejections (aborted loads) also surface via did-fail-load — ignore here
    void wv()
      ?.loadURL(next)
      .catch(() => {})
    inputRef.current?.blur() // hand the keyboard to the page
  }

  return (
    <div className="flex h-full w-full flex-col">
      {/* slim browser toolbar in the node's own chrome colors */}
      <div
        style={{ backgroundColor: 'color-mix(in srgb, var(--np-bg) 85%, transparent)' }}
        className="flex shrink-0 items-center gap-1 border-b border-(--np-edge) px-2 py-1"
      >
        <button
          type="button"
          onClick={() => wv()?.goBack()}
          disabled={!canBack}
          title="Back"
          className={TOOL_BUTTON}
        >
          <ArrowLeft className="h-[20px] w-[20px]" />
        </button>
        <button
          type="button"
          onClick={() => wv()?.goForward()}
          disabled={!canFwd}
          title="Forward"
          className={TOOL_BUTTON}
        >
          <ArrowRight className="h-[20px] w-[20px]" />
        </button>
        <button type="button" onClick={() => wv()?.reload()} title="Reload" className={TOOL_BUTTON}>
          <RotateCw className={`h-[20px] w-[20px] ${loading ? 'animate-spin' : ''}`} />
        </button>
        <form
          className="min-w-0 flex-1"
          onSubmit={(e) => {
            e.preventDefault()
            go()
          }}
        >
          <input
            ref={inputRef}
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            onFocus={(e) => e.target.select()}
            onKeyDown={(e) => {
              // Escape backs out to the loaded page's URL
              if (e.key === 'Escape') {
                e.preventDefault()
                setAddress(pageUrl)
                e.currentTarget.blur()
              }
            }}
            placeholder="Search Google or paste a link"
            spellCheck={false}
            className="nodrag w-full cursor-text rounded-[8px] border border-(--np-edge) bg-white px-2.5 py-1 text-[14px] text-neutral-800 outline-none placeholder:text-neutral-400 focus:ring-2 focus:ring-(--np-ring)"
          />
        </form>
      </div>

      <div className="relative min-h-0 flex-1 bg-white">
        <webview
          ref={webviewRef}
          src={initialUrl}
          // Surface target=_blank / window.open / cmd-click to main's
          // setWindowOpenHandler, which navigates this same guest (one tab per
          // card) instead of opening a window — without this attribute Chromium
          // blocks those clicks outright, so they appear to do nothing.
          // eslint-disable-next-line react/no-unknown-property -- a real <webview> attribute (in React's own types); the lint rule just doesn't know the tag
          allowpopups={true}
          // eslint-disable-next-line react/no-unknown-property -- a real <webview> attribute (in React's own types); the lint rule just doesn't know the tag
          partition={BROWSE_PARTITION}
          // eslint-disable-next-line react/no-unknown-property -- same as above
          useragent={CLEAN_UA}
          style={{ display: 'flex', width: '100%', height: '100%' }}
        />
        {failed && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-white text-neutral-400">
            <Globe className="h-8 w-8" />
            <span className="max-w-full truncate px-3 text-[13px]">{pageUrl}</span>
            <span className="px-3 text-[12px]">Couldn’t load this page ({failed})</span>
          </div>
        )}
        {!focused && !failed && <div className="absolute inset-0" />}
      </div>
    </div>
  )
}
