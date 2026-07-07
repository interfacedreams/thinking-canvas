import { app, ipcMain, protocol } from 'electron'
import { createHash } from 'crypto'
import { promises as fs } from 'fs'
import { join } from 'path'
import {
  getFolderRoot,
  isSafeNodeId,
  readTextIfExists,
  widgetFileFor,
  widgetsDirFor
} from './paths'

// Widget nodes: AI-authored HTML cards rendered inside a sandboxed iframe
// (sandbox="allow-scripts", no allow-same-origin — an opaque origin with no
// access to the app). The renderer can't serve their HTML itself (srcdoc
// would inherit the app CSP, which forbids inline scripts), so a dedicated
// widget:// scheme serves each card's document from .canvas/widgets/<id>.html
// with its own strict CSP: inline JS/CSS, data: URIs, and the two companion
// schemes below — and NO other network egress, so prompt-injected page
// content that flows into a widget has no channel out.
//
// The structure is "code is vendored and pinned; data is brokered and
// allowlisted" (docs/widget-nodes.md §4):
// - widget-pkg:// serves a curated, locally-vendored package shelf
//   (resources/widget-pkgs — Chart.js, Leaflet, d3, …) that a widget opts
//   into via create_widget's `packages`; tags are injected at serve time.
// - widget-tile:// proxies (and caches) OpenStreetMap tiles through main, so
//   Leaflet maps pan live while widget code still never touches the network.
// - canvas.fetch() brokers data requests through main against the widget's
//   declared per-host allowlist (`net`), stored in the document's header.

export const WIDGET_SCHEME = 'widget'
export const WIDGET_PKG_SCHEME = 'widget-pkg'
export const WIDGET_TILE_SCHEME = 'widget-tile'

// A widget document must stay a one-shot artifact, not an unbounded dump.
export const MAX_WIDGET_HTML = 200_000

// --- The package shelf ----------------------------------------------------
// Curated names + exact pinned versions, but NOTHING is vendored into the app
// (except canvas-ui, which is ours): a package's files are fetched from the
// npm CDN the first time any widget declares it, verified against the sha256
// pinned here, cached in userData, and served locally forever after. Widget
// code still never touches the network — main grabs each file once, ever.
// `inject` lists the tags added (in order) when a widget declares the
// package; `files` is the complete servable manifest (anything else 404s).
interface PkgFile {
  /** Path served as widget-pkg://<name>/<rel>. */
  rel: string
  /** Path inside the npm package. */
  npm: string
  sha256: string
}

interface WidgetPkg {
  version: string
  /** npm package name; absent = shipped with the app (canvas-ui). */
  npmName?: string
  inject: { file: string; kind: 'js' | 'css' }[]
  files: PkgFile[]
}

export const WIDGET_PKGS: Record<string, WidgetPkg> = {
  'canvas-ui': {
    version: '1.0.0',
    inject: [{ file: 'canvas-ui.css', kind: 'css' }],
    files: [] // ours — served from resources/widget-pkgs
  },
  chart: {
    version: '4.5.1',
    npmName: 'chart.js',
    inject: [{ file: 'chart.umd.js', kind: 'js' }],
    files: [
      {
        rel: 'chart.umd.js',
        npm: 'dist/chart.umd.js',
        sha256: 'ecc3cd1eeb8c34d2178e3f59fd63ec5a3d84358c11730af0b9958dc886d7652a'
      }
    ]
  },
  leaflet: {
    version: '1.9.4',
    npmName: 'leaflet',
    inject: [
      { file: 'leaflet.css', kind: 'css' },
      { file: 'leaflet.js', kind: 'js' }
    ],
    files: [
      {
        rel: 'leaflet.js',
        npm: 'dist/leaflet.js',
        sha256: 'db49d009c841f5ca34a888c96511ae936fd9f5533e90d8b2c4d57596f4e5641a'
      },
      {
        rel: 'leaflet.css',
        npm: 'dist/leaflet.css',
        sha256: 'a7837102824184820dfa198d1ebcd109ff6d0ff9a2672a074b9a1b4d147d04c6'
      },
      {
        rel: 'images/layers.png',
        npm: 'dist/images/layers.png',
        sha256: '1dbbe9d028e292f36fcba8f8b3a28d5e8932754fc2215b9ac69e4cdecf5107c6'
      },
      {
        rel: 'images/layers-2x.png',
        npm: 'dist/images/layers-2x.png',
        sha256: '066daca850d8ffbef007af00b06eac0015728dee279c51f3cb6c716df7c42edf'
      },
      {
        rel: 'images/marker-icon.png',
        npm: 'dist/images/marker-icon.png',
        sha256: '574c3a5cca85f4114085b6841596d62f00d7c892c7b03f28cbfa301deb1dc437'
      },
      {
        rel: 'images/marker-icon-2x.png',
        npm: 'dist/images/marker-icon-2x.png',
        sha256: '00179c4c1ee830d3a108412ae0d294f55776cfeb085c60129a39aa6fc4ae2528'
      },
      {
        rel: 'images/marker-shadow.png',
        npm: 'dist/images/marker-shadow.png',
        sha256: '264f5c640339f042dd729062cfc04c17f8ea0f29882b538e3848ed8f10edb4da'
      }
    ]
  },
  d3: {
    version: '7.9.0',
    npmName: 'd3',
    inject: [{ file: 'd3.min.js', kind: 'js' }],
    files: [
      {
        rel: 'd3.min.js',
        npm: 'dist/d3.min.js',
        sha256: 'f2094bbf6141b359722c4fe454eb6c4b0f0e42cc10cc7af921fc158fceb86539'
      }
    ]
  },
  dayjs: {
    version: '1.11.21',
    npmName: 'dayjs',
    inject: [{ file: 'dayjs.min.js', kind: 'js' }],
    files: [
      {
        rel: 'dayjs.min.js',
        npm: 'dayjs.min.js',
        sha256: '0198dd0b1f760cded169c7e7ff7eaf56bc36c4c22c7c9b7c683e59437ed8700e'
      }
    ]
  },
  markdown: {
    version: '14.3.0',
    npmName: 'markdown-it',
    inject: [
      { file: 'markdown-it.min.js', kind: 'js' },
      { file: 'purify.min.js', kind: 'js' }
    ],
    files: [
      {
        rel: 'markdown-it.min.js',
        npm: 'dist/markdown-it.min.js',
        sha256: '70fe17bd06c7fa819f03a1ed10957904318103624198845dc893b309bf495e28'
      }
    ]
  },
  // DOMPurify rides the "markdown" package's inject list but is its own npm
  // package — a hidden entry so its file resolves; not offered as a name.
  'markdown-purify': {
    version: '3.4.11',
    npmName: 'dompurify',
    inject: [],
    files: [
      {
        rel: 'purify.min.js',
        npm: 'dist/purify.min.js',
        sha256: 'dbabb5b205a333ec49c8c09e7fca30ef66df0523bb8bc0fa9ea843841f111dbd'
      }
    ]
  }
}

// The names a widget may declare (hidden manifest-only entries excluded).
export const WIDGET_PKG_NAMES = Object.keys(WIDGET_PKGS).filter((n) => n !== 'markdown-purify')

// resources/ is asarUnpack'd, so the same path works packaged and in dev.
const pkgsRoot = (): string =>
  join(app.getAppPath(), 'resources', 'widget-pkgs').replace('app.asar', 'app.asar.unpacked')

// Downloaded-once package files live in userData, never inside the app.
const pkgCacheDir = (): string => join(app.getPath('userData'), 'widget-pkgs')

/** Resolve a package file's bytes: userData cache first, else one fetch from
 *  the npm CDN pinned by exact version AND sha256 — a tampered or drifted
 *  file is rejected, never cached, never served. */
async function pkgFileBytes(name: string, rel: string): Promise<Buffer | null> {
  // The markdown inject list spans two npm packages — resolve purify.min.js
  // through its hidden manifest entry.
  const owner =
    WIDGET_PKGS[name]?.files.some((f) => f.rel === rel) === true
      ? WIDGET_PKGS[name]
      : name === 'markdown' && rel === 'purify.min.js'
        ? WIDGET_PKGS['markdown-purify']
        : undefined
  const entry = owner?.files.find((f) => f.rel === rel)
  if (!owner?.npmName || !entry) return null
  const cachePath = join(pkgCacheDir(), name, rel)
  try {
    return await fs.readFile(cachePath)
  } catch {
    // not cached yet
  }
  try {
    const res = await fetch(
      `https://cdn.jsdelivr.net/npm/${owner.npmName}@${owner.version}/${entry.npm}`,
      {
        headers: { 'User-Agent': `thinking-canvas/${app.getVersion()}` },
        signal: AbortSignal.timeout(20_000)
      }
    )
    if (!res.ok) return null
    const buf = Buffer.from(await res.arrayBuffer())
    const digest = createHash('sha256').update(buf).digest('hex')
    if (digest !== entry.sha256) {
      console.error(`[widget-pkg] ${name}/${rel}: sha256 mismatch — refusing to serve`)
      return null
    }
    await fs.mkdir(join(pkgCacheDir(), name, ...rel.split('/').slice(0, -1)), { recursive: true })
    void fs.writeFile(cachePath, buf).catch(() => {})
    return buf
  } catch {
    return null
  }
}

// --- Widget metadata header -------------------------------------------------
// A widget's declared packages and net allowlist persist as the first line of
// its .html file — self-contained (no sidecar), readable by both the serving
// protocol and the fetch broker, and harmless in the served document.
export interface WidgetMeta {
  packages: string[]
  net: string[]
}

const META_RE = /^<!--#widget (\{.*?\})-->\n?/

export function parseWidgetFile(raw: string): { meta: WidgetMeta; html: string } {
  const meta: WidgetMeta = { packages: [], net: [] }
  const m = META_RE.exec(raw)
  if (!m) return { meta, html: raw }
  try {
    const parsed = JSON.parse(m[1]) as Partial<WidgetMeta>
    if (Array.isArray(parsed.packages)) {
      meta.packages = parsed.packages.filter((p): p is string => typeof p === 'string')
    }
    if (Array.isArray(parsed.net)) {
      meta.net = parsed.net.filter((h): h is string => typeof h === 'string')
    }
  } catch {
    // malformed header — treat as no grants
  }
  return { meta, html: raw.slice(m[0].length) }
}

export async function saveWidgetHtml(
  root: string,
  nodeId: string,
  html: string,
  meta?: WidgetMeta
): Promise<void> {
  await fs.mkdir(widgetsDirFor(root), { recursive: true })
  const header =
    meta && (meta.packages.length > 0 || meta.net.length > 0)
      ? `<!--#widget ${JSON.stringify({ packages: meta.packages, net: meta.net })}-->\n`
      : ''
  await fs.writeFile(widgetFileFor(root, nodeId), header + html.slice(0, MAX_WIDGET_HTML))
}

export async function readWidgetMeta(root: string, nodeId: string): Promise<WidgetMeta | null> {
  const raw = await readTextIfExists(widgetFileFor(root, nodeId))
  if (!raw) return null
  return parseWidgetFile(raw).meta
}

/** Must run before app.whenReady — standard+secure schemes are what let a
 *  sandboxed iframe load these URLs like an ordinary origin. One call: the
 *  privileged-scheme list can only be registered once per process. */
export function registerWidgetScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: WIDGET_SCHEME, privileges: { standard: true, secure: true } },
    { scheme: WIDGET_PKG_SCHEME, privileges: { standard: true, secure: true } },
    { scheme: WIDGET_TILE_SCHEME, privileges: { standard: true, secure: true } }
  ])
}

// The bridge: every widget gets the same tiny API, injected ahead of its own
// code. Outbound messages ride postMessage to the embedding WidgetNodeView
// (which validates, rate-limits, and routes them along the node's edges);
// inbound pushes arrive as { __widgetIn, type, payload } and fan out to
// canvas.on handlers; fetch results resolve by id. The iframe is an opaque
// origin, so '*' targets are the only option — the view checks event.source.
const BRIDGE_SHIM = `<script>
;(() => {
  'use strict'
  const listeners = new Map()
  const fetches = new Map()
  let fetchSeq = 0
  // Focus gating (same contract as every canvas card): an unfocused widget is
  // furniture — wheel over it pans the canvas, not the widget. The first
  // click inside focuses it (and selects its node via the parent); buttons
  // work regardless since clicks are never intercepted. The parent drives
  // unfocus via the reserved __focus message when the node deselects.
  let focused = false
  window.addEventListener('pointerdown', () => {
    if (focused) return
    focused = true
    try { window.parent.postMessage({ __widget: true, focused: true }, '*') } catch {}
  }, { capture: true })
  // Gesture latching across the iframe boundary (mirrors the parent's
  // useForwardedWheel): a run of wheel events with gaps under 200ms is ONE
  // gesture, owned by whoever had the first event. The parent pings
  // __extWheel while an outside gesture runs, so momentum drifting in here
  // forwards back out; when this widget owns a gesture natively it pings
  // wheelUsed out, so momentum drifting OUT gets piped back in as __scroll.
  let selfLast = 0
  let lastExt = 0
  let extLatched = false
  window.addEventListener('wheel', (e) => {
    const now = Date.now()
    const fresh = now - selfLast > 200
    selfLast = now
    if (fresh) extLatched = now - lastExt < 200
    // Forward out: unfocused widgets are canvas furniture, and a gesture
    // latched outside stays outside. A FOCUSED widget owns every wheel,
    // pinch included — a focused map zooms itself; to zoom the canvas,
    // click away first (same rule as scroll).
    if (!focused || extLatched) {
      e.preventDefault()
      e.stopPropagation()
      try {
        window.parent.postMessage({ __widget: true, wheel: {
          dx: e.deltaX, dy: e.deltaY, mode: e.deltaMode,
          cx: e.clientX, cy: e.clientY, ctrl: e.ctrlKey, meta: e.metaKey
        } }, '*')
      } catch {}
      return
    }
    // Consumed natively — tell the parent this widget owns the gesture.
    try { window.parent.postMessage({ __widget: true, wheelUsed: true }, '*') } catch {}
  }, { passive: false, capture: true })
  const api = {
    send: (msg) => {
      if (!msg || typeof msg.type !== 'string') return
      try { window.parent.postMessage({ __widget: true, msg }, '*') } catch {}
    },
    prompt: (text) => api.send({ type: 'prompt', text: String(text) }),
    on: (type, handler) => {
      if (typeof type !== 'string' || typeof handler !== 'function') return
      const set = listeners.get(type) ?? new Set()
      set.add(handler)
      listeners.set(type, set)
    },
    fetch: (url) => new Promise((resolve, reject) => {
      const id = ++fetchSeq
      fetches.set(id, { resolve, reject })
      try { window.parent.postMessage({ __widget: true, fetch: { id, url: String(url) } }, '*') }
      catch (e) { fetches.delete(id); reject(e) }
      setTimeout(() => {
        if (fetches.delete(id)) reject(new Error('canvas.fetch timed out'))
      }, 30000)
    })
  }
  window.addEventListener('message', (e) => {
    const d = e.data
    if (!d || d.__widgetIn !== true) return
    if (d.type === '__focus') {
      focused = d.payload === true
      return
    }
    if (d.type === '__extWheel') {
      lastExt = Date.now()
      return
    }
    if (d.type === '__scroll') {
      // Continuation of a gesture this widget owns, cursor now outside the
      // frame — keep the document scrolling.
      const p = d.payload || {}
      const k = p.mode === 1 ? 16 : 1
      selfLast = Date.now()
      try { window.scrollBy(k * (Number(p.dx) || 0), k * (Number(p.dy) || 0)) } catch {}
      return
    }
    if (typeof d.fetchId === 'number') {
      const p = fetches.get(d.fetchId)
      if (!p) return
      fetches.delete(d.fetchId)
      if (d.error) p.reject(new Error(String(d.error)))
      else p.resolve({
        ok: d.status >= 200 && d.status < 300,
        status: d.status,
        text: () => Promise.resolve(d.body),
        json: () => Promise.resolve(JSON.parse(d.body))
      })
      return
    }
    if (typeof d.type !== 'string') return
    const set = listeners.get(d.type)
    if (set) for (const fn of set) { try { fn(d.payload) } catch {} }
  })
  Object.defineProperty(window, 'canvas', { value: Object.freeze(api) })
})()
</script>`

/** The tags a widget's declared packages inject, css before js, shelf order. */
function packageTags(packages: string[]): string {
  const tags: string[] = []
  for (const name of packages) {
    const pkg = WIDGET_PKGS[name]
    if (!pkg) continue
    for (const f of pkg.inject) {
      tags.push(
        f.kind === 'css'
          ? `<link rel="stylesheet" href="widget-pkg://${name}/${f.file}">`
          : `<script src="widget-pkg://${name}/${f.file}"></script>`
      )
    }
  }
  return tags.join('')
}

/** Weave the bridge shim + package tags into a widget document so they run
 *  before any widget code: right after <head> when there is one, after <html>
 *  otherwise, and ahead of everything (with a doctype so the page isn't
 *  quirks-mode) when the AI wrote a bare fragment. */
export function injectBridge(html: string, packages: string[] = []): string {
  const inject = BRIDGE_SHIM + packageTags(packages)
  const head = /<head[^>]*>/i.exec(html)
  if (head) {
    const at = head.index + head[0].length
    return html.slice(0, at) + inject + html.slice(at)
  }
  const htmlTag = /<html[^>]*>/i.exec(html)
  if (htmlTag) {
    const at = htmlTag.index + htmlTag[0].length
    return html.slice(0, at) + inject + html.slice(at)
  }
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html)
  if (doctype) {
    const at = doctype.index + doctype[0].length
    return html.slice(0, at) + inject + html.slice(at)
  }
  return `<!doctype html><meta charset="utf-8">${inject}${html}`
}

const MIME: Record<string, string> = {
  js: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  png: 'image/png',
  svg: 'image/svg+xml',
  woff2: 'font/woff2'
}

// --- OpenStreetMap tile proxy ----------------------------------------------
// widget-tile://osm/{z}/{x}/{y}.png — fetched by main with a proper UA and
// cached forever in userData (tiles are immutable enough for our use), so
// widget code never touches the network and revisited maps work offline.
const TILE_HOST = 'https://tile.openstreetmap.org'
const tileCacheDir = (): string => join(app.getPath('userData'), 'tile-cache')

async function serveTile(url: URL): Promise<Response> {
  if (url.hostname !== 'osm') return new Response('Unknown tile source', { status: 404 })
  const m = /^\/(\d{1,2})\/(\d+)\/(\d+)\.png$/.exec(url.pathname)
  if (!m) return new Response('Bad tile path', { status: 400 })
  const [z, x, y] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const max = 2 ** z
  if (z > 19 || x < 0 || y < 0 || x >= max || y >= max) {
    return new Response('Tile out of range', { status: 400 })
  }
  const cachePath = join(tileCacheDir(), `${z}-${x}-${y}.png`)
  try {
    const cached = await fs.readFile(cachePath)
    return new Response(new Uint8Array(cached), {
      headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=604800' }
    })
  } catch {
    // not cached yet
  }
  try {
    const res = await fetch(`${TILE_HOST}/${z}/${x}/${y}.png`, {
      headers: { 'User-Agent': `thinking-canvas/${app.getVersion()}` },
      signal: AbortSignal.timeout(10_000)
    })
    if (!res.ok) return new Response('Tile fetch failed', { status: 502 })
    const buf = Buffer.from(await res.arrayBuffer())
    await fs.mkdir(tileCacheDir(), { recursive: true })
    void fs.writeFile(cachePath, buf).catch(() => {})
    return new Response(new Uint8Array(buf), {
      headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=604800' }
    })
  } catch {
    return new Response('Tile fetch failed', { status: 502 })
  }
}

/** Register the widget protocol handlers (after app ready).
 *  - widget://<nodeId>/ — the node's document (host IS the node id; uuids
 *    are lowercase, so hostname lowercasing never bites)
 *  - widget-pkg://<package>/<file> — vendored shelf files
 *  - widget-tile://osm/z/x/y.png — proxied map tiles */
export function registerWidgetProtocol(): void {
  protocol.handle(WIDGET_SCHEME, async (request) => {
    const notFound = new Response('Not found', { status: 404 })
    let nodeId: string
    try {
      nodeId = new URL(request.url).hostname
    } catch {
      return notFound
    }
    const root = getFolderRoot()
    if (!root || !isSafeNodeId(nodeId)) return notFound
    const raw = await readTextIfExists(widgetFileFor(root, nodeId))
    if (!raw) return notFound
    const { meta, html } = parseWidgetFile(raw)
    return new Response(injectBridge(html, meta.packages), {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        // The whole security story in one header: inline code, data: URIs and
        // the two local schemes only — no fetch, no external anything.
        'Content-Security-Policy':
          "default-src 'none'; script-src 'unsafe-inline' widget-pkg:; " +
          "style-src 'unsafe-inline' widget-pkg:; " +
          'img-src data: widget-pkg: widget-tile:; font-src data: widget-pkg:; ' +
          'media-src data:',
        // update_widget rewrites the file in place; the iframe remounts with a
        // fresh rev — never serve a stale cached body.
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff'
      }
    })
  })

  protocol.handle(WIDGET_PKG_SCHEME, async (request) => {
    const notFound = new Response('Not found', { status: 404 })
    let url: URL
    try {
      url = new URL(request.url)
    } catch {
      return notFound
    }
    const pkg = url.hostname
    const def = WIDGET_PKGS[pkg]
    if (!def || pkg === 'markdown-purify') return notFound
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '')
    // Path-safe: plain segments only, no dotfiles, no traversal.
    if (!rel || !rel.split('/').every((s) => s !== '' && !s.startsWith('.'))) return notFound
    const ext = rel.slice(rel.lastIndexOf('.') + 1).toLowerCase()
    const mime = MIME[ext]
    if (!mime) return notFound
    // Our own package (canvas-ui) ships with the app; npm packages resolve
    // through the cache-or-fetch-once path, hash-verified.
    let buf: Buffer | null
    if (!def.npmName) {
      try {
        buf = await fs.readFile(join(pkgsRoot(), pkg, rel))
      } catch {
        buf = null
      }
    } else {
      buf = await pkgFileBytes(pkg, rel)
    }
    if (!buf) return notFound
    return new Response(new Uint8Array(buf), {
      headers: { 'Content-Type': mime, 'Cache-Control': 'public, max-age=86400' }
    })
  })

  protocol.handle(WIDGET_TILE_SCHEME, async (request) => {
    try {
      return await serveTile(new URL(request.url))
    } catch {
      return new Response('Bad tile request', { status: 400 })
    }
  })
}

// --- canvas.fetch broker -----------------------------------------------------
// Widget code has no network; canvas.fetch rides postMessage → renderer →
// this handler. The widget's own file header holds the allowlist (declared at
// create_widget time), so a compromised renderer can't widen a grant — main
// re-reads it from disk per request. GET only, text bodies, hard caps.
const FETCH_TIMEOUT_MS = 15_000
const MAX_FETCH_BYTES = 1_000_000

export interface WidgetFetchResult {
  status?: number
  body?: string
  error?: string
}

export function registerWidgetIpc(): void {
  ipcMain.handle('widget:save', async (_event, nodeId: string, html: string): Promise<void> => {
    const root = getFolderRoot()
    if (!root || !isSafeNodeId(nodeId) || typeof html !== 'string') return
    // Renderer saves keep the widget's existing grants.
    const meta = await readWidgetMeta(root, nodeId)
    await saveWidgetHtml(root, nodeId, html, meta ?? undefined)
  })

  ipcMain.handle('widget:delete', async (_event, nodeId: string): Promise<void> => {
    const root = getFolderRoot()
    if (!root || !isSafeNodeId(nodeId)) return
    try {
      await fs.unlink(widgetFileFor(root, nodeId))
    } catch {
      // never had a widget file
    }
  })

  ipcMain.handle(
    'widget:fetch',
    async (_event, nodeId: string, rawUrl: string): Promise<WidgetFetchResult> => {
      const root = getFolderRoot()
      if (!root || !isSafeNodeId(nodeId) || typeof rawUrl !== 'string') {
        return { error: 'Bad fetch request' }
      }
      const meta = await readWidgetMeta(root, nodeId)
      if (!meta) return { error: 'Unknown widget' }
      let url: URL
      try {
        url = new URL(rawUrl)
      } catch {
        return { error: 'Unparsable URL' }
      }
      if (url.protocol !== 'https:' && url.protocol !== 'http:') {
        return { error: 'Only http(s) URLs are allowed' }
      }
      if (!meta.net.includes(url.hostname)) {
        return {
          error:
            `Host ${url.hostname} is not in this widget's net allowlist ` +
            `(${meta.net.length ? meta.net.join(', ') : 'empty'}). Hosts are declared at ` +
            'create_widget time via the net parameter.'
        }
      }
      try {
        const res = await fetch(url.href, {
          method: 'GET',
          headers: { 'User-Agent': `thinking-canvas/${app.getVersion()}` },
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
        })
        const buf = Buffer.from(await res.arrayBuffer())
        return { status: res.status, body: buf.subarray(0, MAX_FETCH_BYTES).toString('utf8') }
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) }
      }
    }
  )
}
