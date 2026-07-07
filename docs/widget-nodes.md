# Widget Nodes — AI-authored HTML cards with a message bus

A plan for a `widget` node type: a sandboxed HTML/CSS/JS card that a chat's agent
one-shots mid-turn to visualize data or offer interaction — and a small typed
**message bus** so widget clicks can drive other nodes (seek a YouTube tab,
prompt a chat) along ordinary canvas edges.

Motivating scenario: chat ↔ YouTube tab ↔ widget. The user asks for an
interactive timestamped summary; the agent reads the tab's page (already in
context), calls `create_widget` with segment buttons; clicking a segment seeks
the video in the tab.

## Relationship to self-modifying-nodes.md

That doc argues the runtime should emit *data*, never *code*, and calls
per-instance generated HTML "the wrong side of every tradeoff." This plan is the
pragmatic middle step, structured so it converges with that doc rather than
fighting it:

- The **widget node type** (frame, sandbox, persistence, bridge) is hand-written
  code conforming to the node↔canvas boundary — written once, like every node.
- The **message bus** built here *is* Part 2 of that doc (edges as authorized,
  typed message channels) and the `create_widget` tool *is* the first entry in
  Part 3's host library exposed as an agent tool. Both outlive one-shot HTML.
- The HTML blob is instance data rendered inside a hard security + error
  boundary. It's the disposable piece: when a one-shot widget proves durable,
  it graduates into a proper generated node *type* speaking the same message
  protocol — nothing at the seams changes.

So: build the seams to spec, accept HTML-as-data inside them.

## 1. The `widget` node type

Follows the existing discriminated-union pattern exactly (model.ts:175–190).

```ts
export interface WidgetData {
  title: string
  color?: string
  html: string            // hydrated from .canvas/widgets/<id>.html; stripped by buildDoc()
  sourceChatId?: string   // provenance: which chat authored it
  pinned?: boolean
  description?: string
  minimized: boolean
  savedHeight?: number
  updatedAt?: number
  [key: string]: unknown
}
export type WidgetNode = Node<WidgetData, 'widget'>
```

- **Frame**: born at tool-specified `width`/`height` hints, clamped to
  `[280, NODE_W] × [200, MAX_NODE_H]`; default ~480×400. User-resizable,
  content scrolls inside. Standard chrome: drag-handle header, palette color,
  minimize, delete, CTX/OUTPUT knobs like note/file/link. Header gets a reload
  button (re-mounts the frame) and a "view source" affordance (debugging).
- **Persistence**: HTML lives in `.canvas/widgets/<id>.html` (the notes
  pattern). `buildDoc()` strips `html`; hydration on load reads it back.
  canvas.json stays small; a corrupt widget can't corrupt the doc.
- **Files touched**: model.ts (data + factory + guard + union),
  shared/types.ts (`NodeKind` + `PersistedNode`), Canvas.tsx `nodeTypes`,
  helpers.ts `buildDoc`/spawn helper, nodesSlice.ts action, main/canvas.ts
  hydration + `widget:save` IPC, new `features/nodes/widget/WidgetNodeView.tsx`.

## 2. Rendering & sandbox

Render in an `<iframe sandbox="allow-scripts">` — **not** `allow-same-origin`,
so the widget runs in an opaque origin: no access to the app's DOM, storage,
or preload bridge. Communication is postMessage only.

**Why iframe, not `<webview>` (the link-node precedent).** Everything webview
buys tabs is dead weight here: widgets need no browsing session/cookies, no
navigation history, no UA spoofing, and no guest webContents for CDP/computer
use. Meanwhile webview costs a separate guest process per node (widgets may be
numerous; tabs aren't), can't be reparented (the dock-remount problem TabBrowser
already lives with), is quirky inside React Flow's CSS-transformed canvas
(iframes transform like plain DOM), and makes the bridge worse — a guest can't
postMessage its embedder, so `canvas.send()` would need a guest preload +
ipc-message routing through main. Security is also subtractive with webview
(full network by default; block via session interception) vs. additive with a
sandboxed iframe (opaque origin + CSP = nothing unless granted). If we ever
want computer use to drive a widget's own UI, that needs a guest webContents —
swap the rendering host then; the message-bus seam is identical either way.

**Serving the HTML.** `srcdoc` inherits the renderer's CSP, which will fight
inline scripts. Cleaner: register a custom scheme in main —
`widget://<nodeId>` serves `.canvas/widgets/<id>.html` with its own headers:

```
Content-Security-Policy: default-src 'none'; script-src 'unsafe-inline';
  style-src 'unsafe-inline'; img-src data:; font-src data:
```

That gives widgets inline JS/CSS and data-URI images, and **no network at
all** — no exfiltration channel, no CDN flakiness, matches "single one-shot
file" authoring. (Fallback if the custom scheme misbehaves with sandboxed
iframes: blob URL + relaxed frame-src.)

**The bridge.** Before serving, the protocol handler prepends a tiny runtime
shim so every widget gets the same API:

```js
window.canvas = {
  send(msg)            // {type, ...payload} → parent via postMessage
  prompt(text)         // sugar for send({type:'prompt', text})
  on(type, handler)    // inbound data pushes from the app
}
```

`WidgetNodeView` holds the other end: listens for `message` events, checks
`event.source === iframe.contentWindow`, validates the payload against a small
schema allowlist, rate-limits (e.g. 10 msgs/sec), then hands it to the router.
Inbound direction: `iframe.contentWindow.postMessage(msg, '*')`.

## 3. Creation path: a `canvas` MCP server

Mirror the computer-use precedent exactly (computerUse.ts in-process MCP server,
wired via `mcpServers` at thread.ts:703; events emitted like `computer-action`).

New in-process server `mcp__canvas__*` with two tools:

- `create_widget({ title, html, width?, height?, connect? })` → returns
  `{ widgetId }`. Main persists the HTML, then emits a ThreadEvent
  (`type: 'widget-created'`); events.ts spawns the node near the chat (free-spot
  placement), wires context edges, drops a chip in the transcript (like
  computer-action chips).
- `update_widget({ widgetId, html })` → rewrites the file, emits
  `widget-updated`; the view re-mounts the frame. This is what makes iteration
  ("make the buttons bigger") cheap.

**Wiring on creation**: default `connect` = the authoring chat **plus every
node currently wired to that chat** (so a YouTube tab in context is reachable
without the model knowing ids). Explicit `connect: [nodeId]` overrides.

**Ids in context**: today's context blocks (`<note title=…>`, thread.ts:466–552)
don't carry node ids. Add `id="…"` to note/link/file/chat context blocks so the
model can address `connect` targets and message recipients precisely.

**Prompting**: the tool description carries the authoring contract — single
self-contained HTML document, inline CSS/JS only, no external resources (CSP
will eat them), the `window.canvas` API with examples, and the message types
connected nodes accept (see §4). Auto-allow both tools in `canUseTool` —
they're sandboxed and reversible, no permission pill needed.

## 4. The message bus

Widget messages route along **existing context edges** — an edge is the
authorization to message, per self-modifying-nodes Part 2. No new edge kind.

A renderer-side router (`routeWidgetMessage(widgetId, msg)` in a store helper):
find `peersOf(widgetId)`, deliver to each peer whose kind **accepts** the
message type. MVP accepts-table is hardcoded per node kind:

| Receiver | Accepts | Effect |
|---|---|---|
| link | `seek {seconds}` | `webview.executeJavaScript` → `document.querySelector('video').currentTime = seconds; video.play()` |
| link | `play` / `pause` | same, via the guest's `<video>` |
| link | `navigate {url}` | `webview.loadURL` (same-hostname only, else ignored) |
| chat | `prompt {text}` | fills the composer draft **and sends** as a user turn, rendered with a "from widget" chip; blocked while the chat is streaming (per-node send lock) |
| chat | `draft {text}` | fills the composer only — for "let the user edit before sending" |
| widget | `data {payload}` | delivered to the target widget's `canvas.on('data')` |

Chat→widget data flow without full HTML rewrites comes later as
`set_widget_data(widgetId, json)` → bridge dispatches to `canvas.on('data')`
(nice-to-have, milestone 4).

One hop only, no transitive routing, no loops: a message a widget sends is
never re-emitted by a receiver. If two tabs are wired, both seek — that's the
user's wiring, honored literally.

## 5. Chat context integration

`contextWidgetsFor(id)` in helpers.ts (peersOf ∩ isWidget), assembled into the
system prompt as `<widget id=… title=…>` blocks carrying the widget's HTML
(truncated past ~8–16KB) — so the agent can see, reference, and `update_widget`
what's already on the canvas instead of authoring duplicates.

## 6. YouTube walkthrough (the acceptance test)

Setup: chat ⟷ YouTube link node (context edge), user asks for an interactive
timestamped summary.

1. The send already injects the tab's rendered page (extractPageMarkdown via
   Defuddle) into the system prompt — title, description, transcript if open.
   If the model needs the actual transcript it can drive the tab (computer use)
   or WebFetch; nothing new required.
2. Model calls `create_widget` with segment rows:
   `onclick="canvas.send({type:'seek', seconds:212})"`.
3. Main persists `.canvas/widgets/<id>.html`, emits `widget-created`; renderer
   spawns the widget near the chat, wires widget⟷chat and widget⟷tab (inherited
   from the chat's neighborhood), drops a transcript chip.
4. User clicks "3:32 — the demo": bridge → router → link node peer accepts
   `seek` → `executeJavaScript` on the guest → video jumps. No model in the
   loop; instant.
5. User clicks "explain this section" (a `canvas.prompt(...)` button) → the
   chat sends a user turn; the reply can `update_widget` to enrich that row.

## 7. Security posture

- Opaque-origin iframe, `sandbox="allow-scripts"` only. No `allow-same-origin`,
  `allow-popups`, `allow-top-navigation`, ever.
- CSP `default-src 'none'` at the protocol layer: no network egress even though
  prompt-injected page content (the YouTube page!) flows into widget HTML.
  Exfiltration via message bus is bounded by the accepts-table (`navigate` is
  same-hostname; `prompt` is visible in the transcript as a user turn).
- Parent validates `event.source`, schema-checks every message, rate-limits.
- Widget crash = its frame dies; the node shows a "reload" state (error
  boundary at the card level). Nothing touches canvas.json integrity.

## 8. Milestones (each independently shippable)

1. **The node** — type/factory/view/persistence/hydration; sandboxed frame via
   `widget://` protocol; hand-written test widget renders, resizes, survives
   restart. No AI, no messages.
2. **The tool** — `canvas` MCP server, `create_widget`/`update_widget`,
   `widget-created` events → spawn + wire + chip; authoring contract in tool
   description; ids added to context blocks. Acceptance: "make me a widget
   showing this data as a bar chart" works end-to-end.
3. **The bus** — bridge shim, router, link `seek/play/navigate` + chat
   `prompt/draft` handlers. Acceptance: the YouTube walkthrough (§6).
4. **Polish** — `contextWidgetsFor` context blocks, `set_widget_data`, pinning
   (description blurb in MEMORY.md), widget→widget `data` messages.

## Open questions

- Should `prompt` auto-send or only fill the draft? Auto-send is the magic
  demo; draft-only is safer against annoying widgets. Leaning: auto-send with
  the "from widget" chip, and blocked while streaming.
- Widget HTML size cap (tool arg validation) — 64KB feels right for one-shots.
- Does a pinned widget belong in memory at all, or is a widget always ephemeral
  scaffolding? Defer until real usage says.
