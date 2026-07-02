import { memo, useEffect, useRef, useState, type RefObject } from 'react'
// The legacy build, deliberately: the modern one assumes bleeding-edge JS
// (Map.getOrInsertComputed and friends) that Electron's Chromium may not have
// yet — pages then fail to rasterize with a TypeError. Legacy polyfills it.
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist/legacy/build/pdf.mjs'
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'
import { FileWarning } from 'lucide-react'
import { useCanvasStore } from '@renderer/store/canvas'
import { useForwardedWheel } from '@renderer/lib/useForwardedWheel'

// pdf.js parses in a worker it spawns via a blob: URL — index.html's CSP
// carries `worker-src 'self' blob:` for exactly this. If the worker still
// can't start, pdf.js falls back to parsing on the main thread — slower,
// but the viewer works.
pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

// Pages sit on a neutral gutter with a little breathing room, like any
// desktop PDF reader.
const PAGE_GAP = 10
const GUTTER_PAD = 10
// US-Letter height/width — the placeholder aspect until a page is measured.
const DEFAULT_ASPECT = 11 / 8.5
// Cap the canvas backing store so a huge page × retina doesn't balloon memory.
const MAX_CANVAS_W = 3072
// Past this canvas zoom, pages stop gaining backing pixels (a touch soft at
// the extreme; keeps a zoomed-in page from allocating enormous bitmaps).
const MAX_RENDER_ZOOM = 3

/**
 * Inline pdf.js viewer for a file node: every page as a canvas in a scrolling
 * column. Pages render lazily as they near the viewport and are evicted when
 * they leave it (placeholders keep their measured height, so the scrollbar
 * stays honest) — a 600-page PDF holds only a handful of canvases at a time.
 *
 * Scrolling follows the chat-transcript convention: the container is
 * `nowheel` + useForwardedWheel, so only a focused (selected) node scrolls
 * its pages — over an unfocused node the wheel pans the canvas.
 */
function PdfViewer({ file, focused }: { file: string; focused: boolean }): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null)
  const [error, setError] = useState(false)
  // The width pages render at — tracked from the container so node resizes
  // re-rasterize. Debounced: mid-drag the canvases just stretch in CSS.
  const [width, setWidth] = useState(0)

  // `file` is fixed for the life of the component — FileNodeView keys the
  // viewer on it, so a different path means a fresh mount, never a reload.
  useEffect(() => {
    let alive = true
    let task: ReturnType<typeof pdfjs.getDocument> | undefined
    void (async () => {
      try {
        const data = await window.api.file.pdfData(file)
        if (!alive) return
        if (!data) {
          setError(true)
          return
        }
        task = pdfjs.getDocument({ data })
        const loaded = await task.promise
        if (!alive) return // the cleanup's destroy() tears it down
        setDoc(loaded)
      } catch (err) {
        // covers a rejected IPC invoke (e.g. stale main process without the
        // file:pdfData handler) as well as pdf.js parse/worker failures
        console.error('[pdf] open failed:', err)
        if (alive) setError(true)
      }
    })()
    return () => {
      alive = false
      void task?.destroy() // destroys the document and frees the worker data
    }
  }, [file])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const ro = new ResizeObserver(() => {
      clearTimeout(timer)
      timer = setTimeout(() => setWidth(el.clientWidth), 150)
    })
    ro.observe(el)
    setWidth(el.clientWidth)
    return () => {
      clearTimeout(timer)
      ro.disconnect()
    }
  }, [])

  useForwardedWheel(scrollRef, doc !== null, focused)

  // Re-rasterize pages for the zoom each gesture settles on (the store's
  // viewport updates on moveEnd) — zoomed-in pages stay crisp instead of
  // CSS-stretching. Mid-gesture the existing bitmaps just scale.
  const zoom = useCanvasStore((s) => s.viewport.zoom)
  const renderZoom = Math.min(Math.max(zoom, 1), MAX_RENDER_ZOOM)

  const pageWidth = Math.max(0, width - 2 * GUTTER_PAD)

  return (
    <div
      ref={scrollRef}
      className="nowheel select-text h-full w-full overflow-x-hidden overflow-y-auto bg-neutral-200/60"
    >
      {error ? (
        <div className="flex h-full w-full flex-col items-center justify-center gap-2 text-neutral-400">
          <FileWarning className="h-8 w-8" />
          <span className="max-w-full truncate px-3 text-[13px]">{file}</span>
        </div>
      ) : doc && pageWidth > 0 ? (
        <div className="flex flex-col items-center" style={{ padding: GUTTER_PAD, gap: PAGE_GAP }}>
          {Array.from({ length: doc.numPages }, (_, i) => (
            <PdfPage
              key={i + 1}
              doc={doc}
              pageNum={i + 1}
              width={pageWidth}
              renderZoom={renderZoom}
              root={scrollRef}
            />
          ))}
          <div className="pb-1 text-[12px] text-neutral-500">
            {doc.numPages} {doc.numPages === 1 ? 'page' : 'pages'}
          </div>
        </div>
      ) : (
        <div className="flex h-full w-full items-center justify-center text-[13px] text-neutral-400">
          Opening PDF…
        </div>
      )}
    </div>
  )
}

/**
 * One page: a fixed-size white holder (so layout never jumps) whose canvas
 * carries a bitmap only while the page is near the viewport — an undrawn or
 * evicted canvas is transparent, so the holder reads as a blank page. The
 * aspect starts at US-Letter and locks to the real page size on first render.
 */
function PdfPage({
  doc,
  pageNum,
  width,
  renderZoom,
  root
}: {
  doc: PDFDocumentProxy
  pageNum: number
  width: number
  /** Canvas zoom to oversample for, so zoomed-in pages render crisp. */
  renderZoom: number
  root: RefObject<HTMLDivElement | null>
}): React.JSX.Element {
  const holderRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const textRef = useRef<HTMLDivElement>(null)
  const [near, setNear] = useState(false)
  const [aspect, setAspect] = useState(DEFAULT_ASPECT)

  useEffect(() => {
    const el = holderRef.current
    if (!el) return
    const io = new IntersectionObserver(([entry]) => setNear(entry.isIntersecting), {
      root: root.current,
      rootMargin: '200% 0px' // render a couple of screens ahead in both directions
    })
    io.observe(el)
    return () => io.disconnect()
  }, [root])

  useEffect(() => {
    if (!near) {
      // Evicted: drop the backing store (a 0×0 canvas holds no bitmap); the
      // sized holder keeps the page's slot in the scroll.
      const canvas = canvasRef.current
      if (canvas) {
        canvas.width = 0
        canvas.height = 0
      }
      return
    }
    let cancelled = false
    let renderTask: RenderTask | undefined
    void (async () => {
      try {
        const page = await doc.getPage(pageNum)
        if (cancelled) return
        const base = page.getViewport({ scale: 1 })
        setAspect(base.height / base.width)
        // Retina-crisp at the current canvas zoom, capped so extreme sizes
        // can't allocate huge bitmaps.
        const scale = Math.min(
          (width / base.width) * (window.devicePixelRatio || 1) * renderZoom,
          MAX_CANVAS_W / base.width
        )
        const viewport = page.getViewport({ scale })
        // pdf.js insists on exclusive use of its render target — two passes
        // overlapping on one canvas (StrictMode's double effect, a resize
        // landing mid-render) throw. So each pass renders into its own
        // scratch canvas and blits the finished bitmap onto the visible one.
        const scratch = document.createElement('canvas')
        scratch.width = Math.floor(viewport.width)
        scratch.height = Math.floor(viewport.height)
        renderTask = page.render({ canvas: scratch, viewport })
        await renderTask.promise
        const target = canvasRef.current
        if (cancelled || !target) return
        target.width = scratch.width
        target.height = scratch.height
        target.getContext('2d')?.drawImage(scratch, 0, 0)
      } catch (err) {
        // cancellation is routine (scroll, resize, unmount); log real failures
        if (!(err instanceof Error && err.name === 'RenderingCancelledException')) {
          console.error(`[pdf] page ${pageNum} render failed:`, err)
        }
      }
    })()
    return () => {
      cancelled = true
      renderTask?.cancel()
    }
  }, [near, doc, pageNum, width, renderZoom])

  // A transparent layer of positioned glyphs over the canvas, so text can be
  // highlighted and copied. Laid out in CSS pixels (--total-scale-factor =
  // the page's display scale) — independent of the canvas's retina/zoom
  // oversampling, and cheap enough to keep mounted while the page is near.
  useEffect(() => {
    const container = textRef.current
    if (!container) return
    if (!near) {
      container.textContent = '' // drop the spans alongside the evicted bitmap
      return
    }
    let cancelled = false
    let textLayer: pdfjs.TextLayer | undefined
    void (async () => {
      try {
        const page = await doc.getPage(pageNum)
        if (cancelled) return
        const base = page.getViewport({ scale: 1 })
        const cssScale = width / base.width
        container.style.setProperty('--total-scale-factor', String(cssScale))
        container.textContent = ''
        textLayer = new pdfjs.TextLayer({
          textContentSource: page.streamTextContent(),
          container,
          viewport: page.getViewport({ scale: cssScale })
        })
        await textLayer.render()
      } catch (err) {
        // cancellation (scroll, resize, unmount) aborts the stream — routine.
        // Selectable text is a nicety, so only surface unexpected failures.
        if (!(err instanceof Error && err.name === 'AbortException')) {
          console.error(`[pdf] page ${pageNum} text layer failed:`, err)
        }
      }
    })()
    return () => {
      cancelled = true
      textLayer?.cancel()
    }
  }, [near, doc, pageNum, width])

  return (
    <div
      ref={holderRef}
      className="relative shrink-0 bg-white shadow-sm"
      style={{ width, height: Math.round(width * aspect) }}
    >
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />
      <div ref={textRef} className="pdf-text-layer" />
    </div>
  )
}

export default memo(PdfViewer)
