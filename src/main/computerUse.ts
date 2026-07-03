import { webContents, nativeImage, type WebContents, type NativeImage } from 'electron'
import {
  createSdkMcpServer,
  tool,
  type McpSdkServerConfigWithInstance
} from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import type { ComputerTarget } from '../shared/types'

// Computer use: an in-process MCP server (mcp__computer__computer) that lets a
// chat turn drive one connected tab's <webview> guest. Mouse events are
// synthesized via sendInputEvent straight into the guest's own coordinate
// space (no focus needed); text goes in via document.execCommand('insertText')
// (no focus needed either); keys go in via sendInputEvent keyboard events,
// which route to the guest's OWN render widget regardless of which element —
// or window — holds real browser-side focus (verified in a host-textarea-vs-
// guest harness: delivered with focus emulation on or off, zero leakage into
// the focused host element). So no input path ever moves the user's focus.
// The renderer's focus guard (useFocusGuard) bounces the
// DOM-focus steal Chromium performs when a
// synthesized click makes the guest request focus. A CDP attachment provides
// focus emulation — the page *believes* it is focused while the user works
// elsewhere — plus a screenshot fallback. Screenshots are
// capturePage({stayHidden}); Blink only renders a guest where it intersects
// the window (partial visibility crops captures, fully offscreen hangs them —
// electron#29113), so whenever a driven tab isn't fully in view the renderer
// counter-transforms its body into a bottom-right picture-in-picture grid
// (DrivenDock) to keep it wholly painted. One tool with an
// `action` discriminator (not a tool per action) because that is the shape
// Claude models are trained on for computer use — they drive it far more
// reliably than a bespoke API.
//
// Deliberately omitted from Anthropic's action set: `left_click_drag` (rare on
// reading-heavy web tasks — revisit if slider/reorder/map tasks show up) and
// `zoom` (its job is reading small text, and native-resolution Retina
// screenshots under the raised MAX_SHOT_WIDTH already do that).

// Screenshot size envelope. The app's model list is all high-res-vision models
// (Sonnet 5, Opus 4.8, Fable 5), where current guidance recommends 1080p-class
// screenshots with 1:1 coordinates and caps input images at 2576px on the long
// edge (larger is rejected). So: width up to 1920 — a Retina tab (2x DPR)
// usually ships at native resolution, which is what makes small text readable —
// and a long-edge ceiling safely under the API limit for tall tabs, whose
// height the width cap alone wouldn't bound. ~3k tokens per shot at 1400×1600.
const MAX_SHOT_WIDTH = 1920
const MAX_SHOT_LONG_EDGE = 2400

// A hard ceiling on loadURL/settle waits — a hung page must not stall the turn.
const LOAD_TIMEOUT_MS = 8000

// How long the capturePage fast path gets before the CDP fallback takes over.
// An offscreen (render-throttled) guest's capturePage may simply never
// resolve, so this must be short enough not to drag every action.
const CAPTURE_TIMEOUT_MS = 1500

// Step cap: the runaway guard (there is no mid-turn stop button, and every
// action costs a screenshot). Enforced in the tool rather than via the SDK's
// maxTurns so the turn degrades gracefully — the model gets a wrap-up warning
// approaching the limit and a refusal past it, and still writes its summary
// instead of dying as an opaque error. A follow-up send naturally resets the
// counter (the server is built per-turn).
const MAX_ACTIONS = 50
const WARN_ACTIONS = 40

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Resolve with the promise's value, or null on rejection/timeout. */
const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T | null> =>
  Promise.race([p.catch(() => null), sleep(ms).then(() => null)])

// sendInputEvent key codes for the names the model uses. Anything not listed
// passes through as-is (single characters, F-keys, …).
const KEY_ALIASES: Record<string, string> = {
  enter: 'Return',
  return: 'Return',
  esc: 'Escape',
  escape: 'Escape',
  tab: 'Tab',
  space: 'Space',
  backspace: 'Backspace',
  delete: 'Delete',
  del: 'Delete',
  up: 'Up',
  arrowup: 'Up',
  down: 'Down',
  arrowdown: 'Down',
  left: 'Left',
  arrowleft: 'Left',
  right: 'Right',
  arrowright: 'Right',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  home: 'Home',
  end: 'End'
}

const MOD_ALIASES: Record<string, 'shift' | 'control' | 'alt' | 'meta'> = {
  shift: 'shift',
  ctrl: 'control',
  control: 'control',
  alt: 'alt',
  option: 'alt',
  cmd: 'meta',
  command: 'meta',
  meta: 'meta'
}

/** Type text as per-character key events into the guest's own widget. The
 *  slow path behind execCommand — but the only typing fallback that
 *  physically cannot escape the tab: sendInputEvent keyboard events target
 *  this webContents' widget no matter what holds real browser-side focus,
 *  unlike webContents.insertText, which resolves "the focused element" across
 *  the window's whole focus tree and once landed agent text in the user's
 *  chat composer. */
function typeChars(wc: WebContents, text: string): void {
  for (const ch of text) {
    if (ch === '\n' || ch === '\r') {
      pressKey(wc, 'Enter')
      continue
    }
    wc.sendInputEvent({ type: 'keyDown', keyCode: ch })
    wc.sendInputEvent({ type: 'char', keyCode: ch })
    wc.sendInputEvent({ type: 'keyUp', keyCode: ch })
  }
}

/** "cmd+a" / "Enter" / "ArrowDown" → keyDown/char/keyUp into the guest.
 *  sendInputEvent delivers to the guest's own widget with NO browser-side
 *  focus at all — verified with the host composer focused, window focused,
 *  focus emulation on and off. Never "upgrade" this to CDP
 *  Input.dispatchKeyEvent: that routes through the window's input router to
 *  the FOCUSED widget (verified — it typed into the host textarea), i.e. it
 *  would land agent keys in whatever the user is editing. */
function pressKey(wc: WebContents, combo: string): void {
  const parts = combo
    .split('+')
    .map((p) => p.trim())
    .filter(Boolean)
  const raw = parts.pop() ?? ''
  const modifiers = parts.flatMap((p) => {
    const mod = MOD_ALIASES[p.toLowerCase()]
    return mod ? [mod] : []
  })
  const keyCode = KEY_ALIASES[raw.toLowerCase()] ?? raw
  wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
  // Printable keys (and Return) need the char event too, or keypress/submit
  // handlers never fire.
  if (keyCode === 'Return' || raw.length === 1) {
    wc.sendInputEvent({ type: 'char', keyCode, modifiers })
  }
  wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
}

/** Wait for the guest to go quiet after an action: a short paint delay, plus
 *  (if the action started a navigation) the load itself, capped. */
async function settle(wc: WebContents, quietMs: number): Promise<void> {
  await sleep(quietMs)
  if (wc.isDestroyed() || !wc.isLoading()) return
  await new Promise<void>((res) => {
    const done = (): void => {
      clearTimeout(timer)
      wc.removeListener('did-stop-loading', done)
      res()
    }
    const timer = setTimeout(done, LOAD_TIMEOUT_MS)
    wc.on('did-stop-loading', done)
  })
  if (!wc.isDestroyed()) await sleep(250) // let the fresh page paint
}

const trunc = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s)

/** One-line human description of a computer action — the transcript chip text.
 *  Rendered in main so the renderer stays dumb about the tool's schema. */
export function describeComputerAction(input: Record<string, unknown>): string {
  const action = typeof input.action === 'string' ? input.action : '?'
  const coord = Array.isArray(input.coordinate) ? (input.coordinate as number[]) : null
  const at = coord ? ` (${Math.round(coord[0])}, ${Math.round(coord[1])})` : ''
  const text = typeof input.text === 'string' ? input.text : ''
  switch (action) {
    case 'screenshot':
      return 'Looking at the page'
    case 'left_click':
      return `Clicking${at}`
    case 'double_click':
      return `Double-clicking${at}`
    case 'right_click':
      return `Right-clicking${at}`
    case 'mouse_move':
      return `Hovering${at}`
    case 'type':
      return `Typing “${trunc(text, 48)}”`
    case 'key':
      return `Pressing ${text || 'a key'}`
    case 'scroll': {
      const dir = typeof input.scroll_direction === 'string' ? input.scroll_direction : 'down'
      return `Scrolling ${dir}`
    }
    case 'navigate': {
      try {
        return `Opening ${new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`).hostname}`
      } catch {
        return 'Opening a page'
      }
    }
    case 'back':
      return 'Going back'
    case 'wait':
      return 'Waiting for the page'
    default:
      return action
  }
}

/** Rides every turn where computer use is NOT active: the model must relay
 *  how to enable it instead of claiming it has no browser tool (or worse,
 *  pretending to browse). Wording mirrors the renderer's toast. */
export const COMPUTER_OFF_APPEND =
  'COMPUTER USE — this app can let you drive a browser tab (clicks, typing, scrolling), ' +
  'but it is OFF for this request, so never claim you browsed interactively. If the user ' +
  'asks you to browse, click around, or control a page, tell them how to enable it: ' +
  'drag the square connector on a browser tab onto the chat to wire them together, then ' +
  'press the mouse-pointer icon in the composer and send again. If they only need ' +
  'information from a page, answer from attached page content or WebFetch as normal.'

/** The computer-use section of the turn's system prompt. */
export function computerAppend(target: ComputerTarget): string {
  return (
    'COMPUTER USE — browser control is on for this request. The user connected a live ' +
    `browser tab (${JSON.stringify(target.title)} at ${target.url}) and armed you to drive ` +
    'it with the mcp__computer__computer tool. The tab runs inside the user’s own app with ' +
    'the user’s own logins and cookies, and the user watches it live while you work.\n' +
    '- Start with action "screenshot" to see the page. Every action returns a fresh ' +
    'screenshot — study it and confirm the previous action actually worked before acting ' +
    'again.\n' +
    '- Coordinates are [x, y] pixels in the most recent screenshot, origin at the top-left. ' +
    'Click the visual center of targets.\n' +
    '- Use "navigate" to jump straight to a URL you already know, and "back" for history — ' +
    'much faster than clicking through pages.\n' +
    '- "type" goes to whatever element is focused: click the field first, then type. Press ' +
    '"Enter" to submit. Prefer keys (Tab, arrows, Enter) for dropdowns and forms — they are ' +
    'more reliable than clicking small controls.\n' +
    '- "mouse_move" hovers without clicking — use it to open hover menus and tooltips, or to ' +
    'check what a control does before committing to a click.\n' +
    `- You have at most ${MAX_ACTIONS} actions for this request. Be efficient; if you near ` +
    'the limit, stop browsing and report what you have.\n' +
    '- Pages continue below the fold: scroll to explore. If a page looks blank or stale, ' +
    'use action "wait" and screenshot again.\n' +
    '- The user handles logins themselves: never enter credentials or payment details, and ' +
    'never post, submit, buy, or send anything on the user’s behalf unless they explicitly ' +
    'asked for exactly that. If a login wall appears, stop and ask the user to log in ' +
    'manually in the tab, then continue once they say so.\n' +
    '- Keep track of the URL of each page that backs a finding (note it when you navigate ' +
    'or after clicking through), and when applicable cite those pages in your reply as ' +
    'markdown links — e.g. the exact listing, product page, or article — so the user can ' +
    'click through and verify instead of taking your word for it.\n' +
    'Work autonomously until the task is done, then summarize what you found.'
  )
}

/** Build the per-turn computer server bound to one guest webContents. */
export function createComputerServer(target: ComputerTarget): McpSdkServerConfigWithInstance {
  // Scale of the model's coordinate space: set by the latest screenshot
  // (model pixels ÷ screenshot pixels → CSS pixels for sendInputEvent).
  let lastShot: { pngW: number; pngH: number; cssW: number; cssH: number } | null = null
  // Actions taken this turn — drives the step cap (see MAX_ACTIONS).
  let actionsUsed = 0

  const liveGuest = (): WebContents | null => {
    const wc = webContents.fromId(target.webContentsId)
    return wc && !wc.isDestroyed() ? wc : null
  }

  // --- CDP attachment ------------------------------------------------------
  // Two jobs: (1) Emulation.setFocusEmulationEnabled keeps the page believing
  // it is focused while the user works elsewhere — the caret stays live, blur
  // handlers don't fire, and execCommand typing keeps landing in the page's
  // focused editable. (2) Page.captureScreenshot backs up capturePage.
  // Re-checked every action: the attach survives across turns but drops on
  // tab reload or if DevTools claims the guest.
  let focusEmulated = false
  const ensureCdp = async (wc: WebContents): Promise<boolean> => {
    try {
      if (!wc.debugger.isAttached()) {
        wc.debugger.attach('1.3')
        focusEmulated = false
        wc.debugger.once('detach', () => {
          focusEmulated = false
        })
      }
      if (!focusEmulated) {
        await wc.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
        focusEmulated = true
      }
      return true
    } catch {
      return false
    }
  }

  // True when the latest frame needed the CDP fallback — the tell that the
  // tab's <webview> is scrolled offscreen and Blink is render-throttling it.
  let capturedOffscreen = false

  /** Raw frame grab. Fast path is capturePage with stayHidden (the capturer
   *  count forces frame production for pages Chromium considers hidden). For
   *  a guest render-throttled offscreen that can still hang or come back
   *  empty (electron#29113), so it races a short timeout and falls back to a
   *  CDP readback, which composites the throttled guest on demand. */
  const grabFrame = async (wc: WebContents): Promise<NativeImage> => {
    const fast = await withTimeout(
      wc.capturePage(undefined, { stayHidden: true }),
      CAPTURE_TIMEOUT_MS
    )
    if (fast && !fast.isEmpty()) {
      capturedOffscreen = false
      return fast
    }
    if (!(await ensureCdp(wc))) {
      throw new Error(
        'screenshot failed — the tab looks scrolled offscreen and the devtools fallback is ' +
          'unavailable. Ask the user to pan the canvas until the tab is at least partly visible.'
      )
    }
    const { data } = (await wc.debugger.sendCommand('Page.captureScreenshot', {
      format: 'png'
    })) as { data: string }
    const img = nativeImage.createFromBuffer(Buffer.from(data, 'base64'))
    if (img.isEmpty()) {
      throw new Error(
        'screenshot came back empty — ask the user to pan the canvas so the tab is visible.'
      )
    }
    capturedOffscreen = true
    return img
  }

  const capture = async (
    wc: WebContents
  ): Promise<{ type: 'image'; data: string; mimeType: string }> => {
    // CSS viewport for the coordinate map — innerWidth/innerHeight is the same
    // box capturePage shoots.
    let cssW = 0
    let cssH = 0
    try {
      const vp = (await wc.executeJavaScript(
        '({ w: window.innerWidth, h: window.innerHeight })'
      )) as { w?: number; h?: number }
      if (typeof vp?.w === 'number' && vp.w > 0) cssW = vp.w
      if (typeof vp?.h === 'number' && vp.h > 0) cssH = vp.h
    } catch {
      // page mid-navigation — fall back to the image's own size below
    }
    const img = await grabFrame(wc)
    const size = img.getSize()
    const scale = Math.min(
      1,
      MAX_SHOT_WIDTH / size.width,
      MAX_SHOT_LONG_EDGE / Math.max(size.width, size.height)
    )
    const resized = scale < 1 ? img.resize({ width: Math.floor(size.width * scale) }) : img
    const png = resized.toPNG()
    // Ground truth for the model's coordinate space: the PNG's real pixel
    // dimensions from its IHDR header — immune to Retina/DIP ambiguity in
    // NativeImage sizing.
    const pngW = png.readUInt32BE(16)
    const pngH = png.readUInt32BE(20)
    lastShot = { pngW, pngH, cssW: cssW || pngW, cssH: cssH || pngH }
    return { type: 'image', data: png.toString('base64'), mimeType: 'image/png' }
  }

  /** Model coordinates (pixels in the last screenshot) → guest CSS coordinates. */
  const toCss = async (
    wc: WebContents,
    coord: [number, number]
  ): Promise<{ x: number; y: number }> => {
    if (!lastShot) await capture(wc) // no screenshot yet — measure once to get the scale
    const s = lastShot!
    const clamp = (v: number, max: number): number => Math.min(Math.max(v, 0), max)
    return {
      x: Math.round(clamp(coord[0], s.pngW - 1) * (s.cssW / s.pngW)),
      y: Math.round(clamp(coord[1], s.pngH - 1) * (s.cssH / s.pngH))
    }
  }

  const click = (
    wc: WebContents,
    x: number,
    y: number,
    button: 'left' | 'right',
    clicks: number
  ): void => {
    // No wc.focus(): synthesized mouse events deliver regardless of focus,
    // and the click still sets the guest's internal focused element — so the
    // user's own input focus is never stolen.
    wc.sendInputEvent({ type: 'mouseMove', x, y })
    for (let i = 1; i <= clicks; i++) {
      wc.sendInputEvent({ type: 'mouseDown', x, y, button, clickCount: i })
      wc.sendInputEvent({ type: 'mouseUp', x, y, button, clickCount: i })
    }
  }

  const computer = tool(
    'computer',
    'Control the connected browser tab: look at it (screenshot) and interact with it ' +
      '(click, type, press keys, scroll, navigate). Coordinates are pixels in the most ' +
      'recent screenshot, origin top-left. Every action returns a fresh screenshot of ' +
      'the page afterwards.',
    {
      action: z
        .enum([
          'screenshot',
          'left_click',
          'double_click',
          'right_click',
          'mouse_move',
          'type',
          'key',
          'scroll',
          'navigate',
          'back',
          'wait'
        ])
        .describe('The action to perform'),
      coordinate: z
        .tuple([z.number(), z.number()])
        .optional()
        .describe(
          '[x, y] pixel position in the latest screenshot — required for clicks and mouse_move, optional anchor for scroll'
        ),
      text: z
        .string()
        .optional()
        .describe(
          'The text to type (type), the key or combo to press e.g. "Enter", "cmd+a", "ArrowDown" (key), or the URL to open (navigate)'
        ),
      scroll_direction: z.enum(['up', 'down', 'left', 'right']).optional(),
      scroll_amount: z.number().optional().describe('Scroll wheel ticks, default 3'),
      duration: z.number().optional().describe('Seconds to wait (wait action), max 10')
    },
    async (args) => {
      const wc = liveGuest()
      if (!wc) {
        return {
          content: [
            {
              type: 'text' as const,
              text:
                'The connected browser tab is gone (closed, minimized, or reloaded). ' +
                'Stop and tell the user to reopen the tab and send the request again.'
            }
          ],
          isError: true
        }
      }
      actionsUsed++
      if (actionsUsed > MAX_ACTIONS) {
        return {
          content: [
            {
              type: 'text' as const,
              text:
                `Action limit reached (${MAX_ACTIONS} per request). Do not call this tool ` +
                'again — summarize what you found so far and, if the task is unfinished, ' +
                'tell the user to send a follow-up message to continue browsing.'
            }
          ],
          isError: true
        }
      }
      try {
        // Arm focus emulation from the first action so the page acts focused
        // for the whole turn (failure is fine — type/key re-check and fall
        // back to the legacy focus-stealing path).
        await ensureCdp(wc)
        let desc = describeComputerAction(args as Record<string, unknown>)
        let quiet = 400
        switch (args.action) {
          case 'screenshot':
            quiet = 0
            break
          case 'left_click':
          case 'double_click':
          case 'right_click': {
            if (!args.coordinate) throw new Error('coordinate is required for clicks')
            const { x, y } = await toCss(wc, args.coordinate)
            click(
              wc,
              x,
              y,
              args.action === 'right_click' ? 'right' : 'left',
              args.action === 'double_click' ? 2 : 1
            )
            quiet = 600
            break
          }
          case 'mouse_move': {
            if (!args.coordinate) throw new Error('coordinate is required for mouse_move')
            const { x, y } = await toCss(wc, args.coordinate)
            wc.sendInputEvent({ type: 'mouseMove', x, y })
            quiet = 500 // hover menus animate open
            break
          }
          case 'type': {
            if (!args.text) throw new Error('text is required for type')
            // execCommand inserts into the guest's internally-focused editable
            // with no browser-side focus at all — the same event stream as an
            // IME commit (beforeinput/input), so frameworks see it. When the
            // guest has no focused editable it returns false; fall back to
            // per-character key events, which cannot land anywhere but this
            // tab.
            const text = args.text
            const inserted = (await wc.executeJavaScript(
              `document.execCommand('insertText', false, ${JSON.stringify(text)})`
            )) as boolean
            if (!inserted) {
              typeChars(wc, text)
            }
            quiet = 300
            break
          }
          case 'key': {
            if (!args.text) throw new Error('text is required for key')
            pressKey(wc, args.text)
            quiet = 500
            break
          }
          case 'scroll': {
            const anchor = args.coordinate
              ? await toCss(wc, args.coordinate)
              : lastShot
                ? { x: Math.round(lastShot.cssW / 2), y: Math.round(lastShot.cssH / 2) }
                : { x: 200, y: 200 }
            const ticks = 120 * Math.min(Math.max(args.scroll_amount ?? 3, 1), 20)
            const dir = args.scroll_direction ?? 'down'
            // sendInputEvent wheel deltas: positive scrolls up/left.
            wc.sendInputEvent({
              type: 'mouseWheel',
              x: anchor.x,
              y: anchor.y,
              deltaX: dir === 'left' ? ticks : dir === 'right' ? -ticks : 0,
              deltaY: dir === 'up' ? ticks : dir === 'down' ? -ticks : 0,
              canScroll: true
            })
            quiet = 400
            break
          }
          case 'navigate': {
            if (!args.text) throw new Error('text (the URL) is required for navigate')
            const url = /^https?:\/\//i.test(args.text) ? args.text : `https://${args.text}`
            new URL(url) // reject junk before handing it to the guest
            // Rejections (e.g. ERR_ABORTED on redirects) are routine — the
            // screenshot below shows what actually loaded.
            await Promise.race([wc.loadURL(url).catch(() => {}), sleep(LOAD_TIMEOUT_MS)])
            quiet = 300
            break
          }
          case 'back': {
            wc.navigationHistory.goBack()
            quiet = 600
            break
          }
          case 'wait': {
            quiet = Math.min(Math.max(args.duration ?? 1, 0.2), 10) * 1000
            desc = `Waited ${(quiet / 1000).toFixed(1)}s`
            break
          }
        }
        await settle(wc, quiet)
        if (wc.isDestroyed()) throw new Error('the browser tab closed mid-action')
        const shot = await capture(wc)
        const title = wc.getTitle()
        const url = wc.getURL()
        const warn =
          actionsUsed >= WARN_ACTIONS
            ? `\nNOTE: ${actionsUsed} of ${MAX_ACTIONS} actions used this request — wrap up and report your findings.`
            : ''
        const offscreen = capturedOffscreen
          ? '\nNOTE: the tab is scrolled offscreen on the canvas (screenshot taken via fallback). ' +
            'The page still works but may render/animate sluggishly; if it looks stale or stuck, ' +
            'tell the user to pan the canvas so the tab is visible.'
          : ''
        return {
          content: [
            {
              type: 'text' as const,
              text:
                `${desc}. Current page: ${title ? `${JSON.stringify(title)} — ` : ''}${url}\n` +
                `Screenshot (${lastShot!.pngW}x${lastShot!.pngH}):${offscreen}${warn}`
            },
            shot
          ]
        }
      } catch (err) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Action failed: ${err instanceof Error ? err.message : String(err)}`
            }
          ],
          isError: true
        }
      }
    }
  )

  return createSdkMcpServer({ name: 'computer', version: '1.0.0', tools: [computer] })
}
