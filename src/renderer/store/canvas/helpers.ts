import type { StoreApi } from 'zustand'
import type { Viewport } from '@xyflow/react'
import type {
  CanvasDoc,
  ComputerTarget,
  ContextFile,
  ContextLink,
  FolderState,
  PersistedEdge
} from '@shared/types'
import { nextColorId } from '@renderer/lib/palette'
import { extractPageMarkdown, guestWebContentsId } from '@renderer/features/nodes/link/pageText'
import {
  CLAUDE_MD_ID,
  CLAUDE_MD_POS,
  GAP,
  KNOB_CLEARANCE,
  NODE_W,
  boxOf,
  fileFrame,
  hostTitle,
  isChat,
  isFile,
  isLabel,
  isLink,
  isNote,
  isWidget,
  makeFileNode,
  makeLinkNode,
  makeNode,
  makeNoteNode,
  uid
} from './model'
import type { CanvasNode, ChatNode, FileNode, NoteNode, PendingFile } from './model'
import type { CanvasState } from './state'
import { animateMoves, resolveCollisions, settleMoves, type GravityBias } from './autoLayout'
import { noteSaveTimers, pendingFileInjections, pendingGravitySeeds } from './runtime'

// Debounced layout save (canvas.json) — one timer for the whole canvas.
let saveTimer: ReturnType<typeof setTimeout> | undefined

/**
 * The store's shared internals: persistence, context gathering, turn dispatch
 * and node spawning, closed over the store's own set/get. Built once inside
 * create() and handed to every slice.
 */
// The return type IS the StoreCtx definition (inferred below) — spelling out
// all ~25 member signatures here would just duplicate it.
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export function createStoreHelpers(
  set: StoreApi<CanvasState>['setState'],
  get: StoreApi<CanvasState>['getState']
) {
  const patchData = (id: string, patch: Record<string, unknown>): void => {
    set((s) => ({
      nodes: s.nodes.map((n) =>
        n.id === id ? ({ ...n, data: { ...n.data, ...patch } } as CanvasNode) : n
      )
    }))
  }

  const buildDoc = (): CanvasDoc => {
    const { nodes, edges, viewport } = get()
    return {
      version: 1,
      nodes: nodes.map((n) => {
        const height = n.data.minimized ? n.data.savedHeight : n.height
        return {
          id: n.id,
          ...(isNote(n)
            ? {
                kind: 'note' as const,
                ...(n.data.pinned ? { pinned: true } : {}),
                ...(n.data.description ? { description: n.data.description } : {}),
                ...(n.data.system ? { system: n.data.system } : {})
              }
            : isFile(n)
              ? {
                  kind: 'file' as const,
                  ...(n.data.file ? { file: n.data.file } : {}),
                  ...(n.data.pinned ? { pinned: true } : {}),
                  ...(n.data.description ? { description: n.data.description } : {})
                }
              : isLink(n)
                ? {
                    kind: 'link' as const,
                    ...(n.data.url ? { url: n.data.url } : {}),
                    ...(n.data.pinned ? { pinned: true } : {}),
                    ...(n.data.description ? { description: n.data.description } : {})
                  }
                : isLabel(n)
                  ? { kind: 'label' as const }
                  : isWidget(n)
                    ? {
                        kind: 'widget' as const,
                        ...(n.data.pinned ? { pinned: true } : {}),
                        ...(n.data.description ? { description: n.data.description } : {})
                      }
                    : n.data.kind === 'research'
                      ? { kind: 'research' as const }
                      : {
                          // A plain chat (no `kind`) — only its memory metadata rides
                          // canvas.json; the transcript saves to its own thread file.
                          ...(n.data.pinned ? { pinned: true } : {}),
                          ...(n.data.description ? { description: n.data.description } : {})
                        }),
          position: n.position,
          width: n.width ?? NODE_W,
          ...(height != null ? { height } : {}),
          title: n.data.title,
          ...(n.data.updatedAt != null ? { updatedAt: n.data.updatedAt } : {}),
          ...(n.data.color ? { color: n.data.color } : {}),
          ...(n.data.minimized ? { minimized: true } : {}),
          ...(!isFile(n) && !isLink(n) && !isLabel(n) && !isWidget(n) && n.data.sessionId
            ? { sessionId: n.data.sessionId }
            : {}),
          ...(isChat(n) && n.data.forkOf ? { forkOf: n.data.forkOf } : {}),
          ...(isChat(n) && n.data.injectedImages?.length
            ? { injectedImages: n.data.injectedImages }
            : {})
        }
      }),
      edges,
      viewport
    }
  }

  const persist = (): void => {
    if (!get().loaded) return
    clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      saveTimer = undefined
      void window.api.canvas.save(buildDoc())
    }, 500)
  }

  // Transcripts persist one file per node, written when a turn's messages
  // settle (user send, turn done) rather than on the debounced layout save.
  const persistThread = (id: string): void => {
    const node = get().nodes.find((n) => n.id === id)
    if (!node || !isChat(node)) return
    // Skip the still-empty assistant placeholder so a reload mid-turn
    // doesn't render a blank bubble.
    const messages = node.data.messages.filter((m) => m.role !== 'assistant' || m.text !== '')
    void window.api.canvas.saveThread(id, messages)
  }

  // Push a note's pending autosave through now — before an AI turn reads the
  // file from disk, and before switching folders.
  const flushNoteSave = async (id: string): Promise<void> => {
    const timer = noteSaveTimers.get(id)
    if (!timer) return
    clearTimeout(timer)
    noteSaveTimers.delete(id)
    const node = get().nodes.find((n) => n.id === id)
    if (node && isNote(node)) await window.api.note.save(id, node.data.content)
  }

  const flushNoteSaves = async (): Promise<void> => {
    await Promise.all([...noteSaveTimers.keys()].map(flushNoteSave))
  }

  // A debounced save writes to whichever folder is current in the main process —
  // flush it before switching so it can't land in the next folder's canvas.
  const flushSave = async (): Promise<void> => {
    await flushNoteSaves()
    if (saveTimer === undefined) return
    clearTimeout(saveTimer)
    saveTimer = undefined
    if (get().loaded) await window.api.canvas.save(buildDoc())
  }

  const switchFolder = async (next: FolderState | null): Promise<Viewport | null> => {
    if (!next) return null // dialog canceled
    if (next.current === get().folder?.current) {
      set({ folder: next }) // same folder re-picked — just refresh the recents order
      return null
    }
    set({
      folder: next,
      nodes: [],
      edges: [],
      viewport: { x: 0, y: 0, zoom: 1 },
      placing: null,
      pendingFile: null,
      transforming: null,
      expanded: null
    })
    const vp = await get().load()
    return vp ?? { x: 0, y: 0, zoom: 1 } // fresh folder: reset the view
  }

  const anyStreaming = (): boolean => get().nodes.some((n) => n.data.status === 'streaming')

  // The persistent CLAUDE.md node refuses deletion, rename, and pinning.
  const isClaudeMd = (id: string): boolean => {
    const n = get().nodes.find((x) => x.id === id)
    return !!n && isNote(n) && n.data.system === 'claudeMd'
  }

  // Serialize a chat's transcript into a plain User/Assistant block — how a
  // chat rides as context (chat → chat edge) or as a derive source that has no
  // forkable session. `clipAt` (a message id) truncates at and including that
  // message: used for a fork parent so the block stops at the branch anchor and
  // never leaks the parent's later messages the fork never saw — a true fork.
  // Empty string when nothing's been said yet.
  const transcriptBlock = (chat: ChatNode, clipAt?: string): string => {
    let msgs = chat.data.messages
    if (clipAt) {
      const i = msgs.findIndex((m) => m.id === clipAt)
      if (i >= 0) msgs = msgs.slice(0, i + 1) // anchor not found → keep full, lose nothing
    }
    return msgs
      .filter((m) => m.text)
      .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.text}`)
      .join('\n\n')
  }

  // Connections are UNDIRECTED: an attachment edge means "these two are
  // connected" — which end is source/target is just how the wire happened to
  // be drawn. What a connection does comes from the node kinds (a note shares
  // its text, a tab its page, a chat its transcript), toggles (the pointer
  // icon arms driving a connected tab), and asking (a connected note is
  // edited only on request). Legacy 'output' edges count as plain connections.
  const isAttachment = (e: PersistedEdge): boolean => e.kind === 'context' || e.kind === 'output'
  const peersOf = (id: string): CanvasNode[] =>
    get().edges.flatMap((e) => {
      if (!isAttachment(e)) return []
      const peerId = e.source === id ? e.target : e.target === id ? e.source : null
      if (!peerId) return []
      const n = get().nodes.find((x) => x.id === peerId)
      return n ? [n] : []
    })

  // Notes connected to a chat go along with every send — read from the store,
  // which always holds the freshest content (autosave debounce notwithstanding).
  const contextNotesFor = (id: string): { id: string; title: string; content: string }[] =>
    peersOf(id)
      .filter(isNote)
      .map((n) => ({ id: n.id, title: n.data.title || 'Untitled note', content: n.data.content }))

  // The chats whose transcripts `id` already carries because its session forks
  // from them: the direct fork-parent chain (fork of a fork resumes the whole
  // chain). Their *transcripts* must not be re-injected as context blocks — but
  // their *documents* still must, since a connected note lives in the system
  // prompt, rebuilt per-send from each chat's own edges, never in the session.
  const forkLineageOf = (id: string): Set<string> => {
    const edges = get().edges
    const out = new Set<string>()
    let cur = id
    // Only fork edges carry a sourceMessageId (context/output/derive never do).
    for (;;) {
      const e = edges.find((x) => x.target === cur && x.sourceMessageId)
      if (!e || out.has(e.source)) break
      out.add(e.source)
      cur = e.source
    }
    return out
  }

  // The chats whose transcripts/documents ride `id`'s sends, oldest → newest —
  // the shared basis for transcript blocks (contextChatsFor) and the documents
  // those chats carry (gathered in dispatchTurn). Two sources, deliberately
  // different depths:
  //  • Fork ancestry, walked to the ROOT: the session resumes those
  //    transcripts, but their attached documents ride the system prompt
  //    (rebuilt per-send from each chat's own connections), so every ancestor
  //    must be gathered. Each arrives with `clipAt` set to its branch anchor
  //    (a true fork: post-branch turns excluded); contextChatsFor drops the
  //    lineage's transcripts since the resumed session already holds them.
  //  • Connected chats, ONE hop only — direct connections of the sender or of
  //    a fork ancestor. A connected chat brings its transcript and its own
  //    directly-attached resources, never its further neighborhood: with
  //    undirected connections, wiring two working chats together must not
  //    silently haul in each other's entire canvas ("direct context only").
  const upstreamChats = (id: string): { chat: ChatNode; clipAt?: string }[] => {
    const nodes = get().nodes
    const edges = get().edges
    const chatById = (nid: string): ChatNode | null => {
      const n = nodes.find((x) => x.id === nid)
      return n && isChat(n) ? n : null
    }
    // Connected chats, either end of the wire — connections are undirected.
    const connectedChatsOf = (chatId: string): ChatNode[] =>
      edges
        .filter((e) => e.kind === 'context' || e.kind === 'output')
        .flatMap((e) => {
          const peerId = e.source === chatId ? e.target : e.target === chatId ? e.source : null
          const n = peerId ? chatById(peerId) : null
          return n ? [n] : []
        })
    const seen = new Set<string>([id])
    // Own fork ancestry, nearest parent first (cycle-safe by `seen`).
    const ancestry: { chat: ChatNode; clipAt?: string }[] = []
    let curId = id
    for (;;) {
      const forkEdge = edges.find((x) => x.target === curId && x.sourceMessageId)
      const parent = forkEdge ? chatById(forkEdge.source) : null
      if (!parent || seen.has(parent.id)) break
      seen.add(parent.id)
      ancestry.push({ chat: parent, clipAt: forkEdge?.sourceMessageId })
      curId = parent.id
    }
    // Oldest ancestor first, so transcript blocks read in conversation order.
    const out: { chat: ChatNode; clipAt?: string }[] = [...ancestry].reverse()
    // One hop of connections from the sender and each fork ancestor.
    for (const baseId of [id, ...ancestry.map((a) => a.chat.id)]) {
      for (const c of connectedChatsOf(baseId)) {
        if (seen.has(c.id)) continue
        seen.add(c.id)
        out.push({ chat: c })
      }
    }
    return out
  }

  // Upstream chats as serialized transcript blocks — same shape as a context
  // note, so main injects them identically. Fork parents arrive clipped. The
  // target's fork lineage is dropped: its transcript already rides the resumed
  // session, so re-injecting it would only duplicate the conversation.
  const contextChatsFor = (id: string): { id: string; title: string; content: string }[] => {
    const lineage = forkLineageOf(id)
    return upstreamChats(id).flatMap(({ chat, clipAt }) => {
      if (lineage.has(chat.id)) return []
      const content = transcriptBlock(chat, clipAt)
      return content ? [{ id: chat.id, title: chat.data.title || 'Chat', content }] : []
    })
  }

  // Files connected to a chat go along as paths; main injects the bytes of any
  // the session hasn't seen (isNew, stamped by send/retry) into the turn's
  // user message. A file whose attach hasn't landed yet (no path) sits out.
  const contextFilesFor = (id: string): ContextFile[] =>
    peersOf(id)
      .filter(isFile)
      .flatMap((n) =>
        n.data.file
          ? [
              {
                id: n.id,
                title: n.data.title || (n.data.kind === 'pdf' ? 'Untitled PDF' : 'Untitled image'),
                file: n.data.file
              }
            ]
          : []
      )

  // Links connected to a chat: each send reads the tab's rendered page out of
  // its live <webview> guest as markdown — what the user sees is what the
  // model gets, so bot walls and JS-only pages that defeat a plain fetch don't
  // matter. A link whose guest can't be read (tab minimized, page hung) goes
  // along as a bare URL and main falls back to the WebFetch instruction.
  // A link whose URL hasn't been committed yet sits out.
  const contextLinksFor = (id: string): ContextLink[] =>
    peersOf(id)
      .filter(isLink)
      .flatMap((n) =>
        n.data.url
          ? [
              {
                id: n.id,
                title: n.data.title || hostTitle(n.data.url) || 'Untitled link',
                url: n.data.url
              }
            ]
          : []
      )

  // Widgets connected to a chat ride the system prompt (id + title + HTML) so
  // the model can reference and update_widget them instead of authoring
  // duplicates. Direct connections only — a widget is scaffolding for the
  // chat beside it, never hauled through upstream chats. Truncated: a widget
  // is bounded, but 16k of HTML per card is all a prompt should carry.
  const contextWidgetsFor = (id: string): { id: string; title: string; html: string }[] =>
    peersOf(id)
      .filter(isWidget)
      .flatMap((n) =>
        n.data.html
          ? [
              {
                id: n.id,
                title: n.data.title || 'Untitled widget',
                html: n.data.html.slice(0, 16_000)
              }
            ]
          : []
      )

  // The tab a computer-use turn drives: the first wired tab (direct wires
  // first, then upstream chats') whose <webview> guest is alive right now —
  // a minimized tab has no guest and sits out, same as page extraction.
  // One rule everywhere: resources wire INTO chats; the wire picks which tab,
  // and the pointer toggle is the one consent gate that grants driving.
  const computerTargetFor = (id: string): ComputerTarget | null => {
    const links = [
      ...contextLinksFor(id),
      ...upstreamChats(id).flatMap((c) => contextLinksFor(c.chat.id))
    ]
    for (const l of links) {
      const webContentsId = guestWebContentsId(l.id)
      if (webContentsId !== null)
        return { targetId: l.id, webContentsId, title: l.title, url: l.url }
    }
    return null
  }

  // Desktop viewport for a driven tab. The webview's CSS viewport is the
  // node's layout size, and below ~1024 CSS px sites serve their mobile
  // layout — hamburger menus, hidden search, no hover — which is much harder
  // for the model to drive. 1280 is the canonical desktop width; 900 tall
  // leaves a ~1280×800 page box under the tab chrome (the classic computer-use
  // envelope). Grow-only: a tab the user already made bigger stays put.
  const COMPUTER_TAB = { width: 1280, height: 900 }
  const growTabForComputer = (targetId: string): void => {
    const node = get().nodes.find((n) => n.id === targetId)
    if (!node || !isLink(node)) return
    const w = node.width ?? node.measured?.width ?? NODE_W
    const h = node.height ?? node.measured?.height ?? 0
    if (w >= COMPUTER_TAB.width && h >= COMPUTER_TAB.height) return
    set((s) => ({
      nodes: s.nodes.map((n) =>
        n.id === targetId
          ? ({
              ...n,
              width: Math.max(w, COMPUTER_TAB.width),
              height: Math.max(h, COMPUTER_TAB.height)
            } as CanvasNode)
          : n
      )
    }))
    persist()
  }

  // A computer-armed send with no wired live tab spawns its own: a Google tab
  // just left of the chat, born at the desktop viewport (so no grow pass) and
  // wired as context like a hand-drawn connection. The turn dispatches once
  // the tab's <webview> guest attaches — see awaitComputerTab.
  const COMPUTER_HOME = 'https://www.google.com'
  const spawnComputerTab = (chat: ChatNode): string => {
    const p = boxOf(chat)
    const node = makeLinkNode(
      // Knob clearance too, so auto layout has nothing to resolve here.
      { x: p.x - GAP - KNOB_CLEARANCE - COMPUTER_TAB.width, y: p.y },
      {
        color: nextColor(),
        updatedAt: Date.now(),
        url: COMPUTER_HOME,
        title: hostTitle(COMPUTER_HOME)
      }
    )
    node.width = COMPUTER_TAB.width
    node.height = COMPUTER_TAB.height
    // One set for node + wire, spawned unselected (same reasons as deriveNote).
    set((s) => ({
      nodes: [...s.nodes, node],
      edges: [...s.edges, { id: uid(), source: node.id, target: chat.id, kind: 'context' as const }]
    }))
    persist()
    pendingGravitySeeds.add(node.id)
    return node.id
  }

  // The fresh tab's guest attaches a few frames after the node mounts (webview
  // mount, attach, first load). Poll briefly; null past the deadline — the
  // turn then runs tabless and the model says so, same as a retry whose tab
  // died.
  const GUEST_ATTACH_MS = 10_000
  const awaitComputerTab = async (tabId: string): Promise<ComputerTarget | null> => {
    const deadline = Date.now() + GUEST_ATTACH_MS
    while (Date.now() < deadline) {
      const webContentsId = guestWebContentsId(tabId)
      const node = get().nodes.find((n) => n.id === tabId)
      if (webContentsId !== null && node && isLink(node) && node.data.url) {
        return {
          targetId: tabId,
          webContentsId,
          title: node.data.title || hostTitle(node.data.url) || 'Untitled link',
          url: node.data.url
        }
      }
      await new Promise((r) => setTimeout(r, 100))
    }
    return null
  }

  const withPageContent = (links: ContextLink[]): Promise<ContextLink[]> =>
    Promise.all(
      links.map(async (l) => {
        const content = await extractPageMarkdown(l.id, l.url)
        return content ? { ...l, content } : l
      })
    )

  // Gather every resource wired into a chat and fire the turn over IPC. Shared
  // by send and retry — the only per-call differences are the prompt text and
  // whether research mode rides along. `node` is the chat as it was before the
  // streaming-state update (its session/fork/injected ledger are read here).
  const dispatchTurn = (
    node: ChatNode,
    text: string,
    opts?: { research?: boolean; computer?: ComputerTarget | null }
  ): void => {
    const id = node.id
    const dedupeById = <T extends { id: string }>(xs: T[]): T[] => {
      const seen = new Set<string>()
      return xs.filter((x) => {
        if (seen.has(x.id)) return false
        seen.add(x.id)
        return true
      })
    }
    // Context is direct-only, one hop through chats: upstreamChats yields the
    // fork ancestry plus directly-connected chats, and each contributes the
    // documents on its OWN connections — not relied on to have soaked into
    // that chat's transcript (they never do: a note lives in the system
    // prompt, not the messages, and an unsent edit wouldn't be there at all).
    // Nothing is gathered beyond that hop. Deduped by node id, since the same
    // document can hang off several of these chats.
    const upstreamIds = upstreamChats(id).map((c) => c.chat.id)
    const contextNotes = dedupeById([
      ...contextNotesFor(id),
      ...upstreamIds.flatMap(contextNotesFor),
      ...contextChatsFor(id) // upstream chats themselves, as transcript blocks
    ])
    // Only files the session hasn't seen carry bytes this turn; remember them so
    // a successful turn marks them injected (a failed turn re-sends on retry).
    const injected = new Set(node.data.injectedImages ?? [])
    const contextFiles = dedupeById([
      ...contextFilesFor(id),
      ...upstreamIds.flatMap(contextFilesFor)
    ]).map((f) => ({ ...f, isNew: !injected.has(f.id) }))
    const newFileIds = contextFiles.filter((f) => f.isNew).map((f) => f.id)
    if (newFileIds.length > 0) pendingFileInjections.set(id, newFileIds)
    else pendingFileInjections.delete(id)
    const contextWidgets = contextWidgetsFor(id)
    // Reading the tabs' rendered pages is async — the composer already cleared
    // and the bubble is streaming-pending, so the await is invisible (and capped
    // by pageText's extraction timeout).
    void (async () => {
      const contextLinks = await withPageContent(
        dedupeById([...contextLinksFor(id), ...upstreamIds.flatMap(contextLinksFor)])
      )
      void window.api.thread.send({
        nodeId: id,
        text,
        sessionId: node.data.sessionId,
        model: get().model,
        effort: get().effort,
        // first send of a forked node: fork the parent session at the anchor
        ...(!node.data.sessionId && node.data.forkOf ? { forkFrom: node.data.forkOf } : {}),
        ...(opts?.research ? { research: true } : {}),
        ...(opts?.computer ? { computer: opts.computer } : {}),
        ...(contextNotes.length > 0 ? { contextNotes } : {}),
        ...(contextFiles.length > 0 ? { contextFiles } : {}),
        ...(contextLinks.length > 0 ? { contextLinks } : {}),
        ...(contextWidgets.length > 0 ? { contextWidgets } : {})
      })
    })()
  }

  // Landing spot for a gravity glide frame — never fights a live drag.
  const applyMoves = (positions: Map<string, { x: number; y: number }>): void => {
    set((s) => ({
      nodes: s.nodes.map((n) => {
        const p = positions.get(n.id)
        return p && !n.dragging ? { ...n, position: p } : n
      })
    }))
  }

  // Gravity auto layout: push whatever the seed nodes overlap out of the way
  // (see autoLayout.ts — the seeds themselves never move). A no-op unless the
  // toggle is on or nothing overlaps; pushed cards glide to their spots and
  // the layout persists once they settle.
  const applyGravity = (seedIds: string[], bias: GravityBias = 'radial'): void => {
    if (!get().autoLayout) return
    settleMoves(applyMoves) // a pass arriving mid-glide finishes the prior one first
    const moves = resolveCollisions(get().nodes, new Set(seedIds), bias)
    if (moves.size === 0) return
    const from = new Map(
      get()
        .nodes.filter((n) => moves.has(n.id))
        .map((n) => [n.id, n.position])
    )
    animateMoves(from, moves, applyMoves, persist)
  }

  // A fresh node takes over keyboard focus (focusDraft) and clears everyone
  // else's selection. Whether it grabs the React Flow *selection* depends on the
  // view: on the bare canvas it stays unselected, because a selected newborn
  // sitting next to an already-selected node makes React Flow drag the pair as a
  // unit (the note-moves-the-chat bug — same reason deriveNote spawns unselected).
  // With a sheet open we keep the old behavior: the new node becomes the
  // selection so it's the panel's focus.
  const adopt = <T extends CanvasNode>(node: T): T => {
    const selected = get().expanded !== null
    const placed = { ...node, selected }
    set((s) => ({
      nodes: [...s.nodes.map((n) => (n.selected ? { ...n, selected: false } : n)), placed]
    }))
    persist()
    // The newborn is the gravity seed: it stays exactly where it was placed
    // (so post-spawn centering still lands on it) and shoves whatever it
    // overlaps out of the way. The push waits for its first measurement —
    // pushing now would use the height estimate (see pendingGravitySeeds).
    pendingGravitySeeds.add(placed.id)
    return placed
  }

  // Cycle the post-it palette: each fresh node takes the color after the
  // most recently created node's (the first one on a canvas gets butter).
  const nextColor = (): string => nextColorId(get().nodes[get().nodes.length - 1]?.data.color)

  // Materialize a file node at a top-left position and make the file part of
  // the folder (copy in, or reference in place) — the relative path from
  // file:attach is what survives a reload.
  const placeFile = (position: { x: number; y: number }, pf: PendingFile): FileNode => {
    const node = adopt(
      makeFileNode(position, fileFrame(pf), {
        title: pf.name.replace(/\.[^.]+$/, ''), // the original file name, sans extension
        color: nextColor(),
        kind: pf.kind,
        updatedAt: Date.now(),
        ...(pf.dataUrl ? { dataUrl: pf.dataUrl } : {})
      })
    )
    void window.api.file.attach(pf.sourcePath).then((res) => {
      if (res) {
        patchData(node.id, { file: res.file })
        persist()
      }
    })
    return node
  }

  const spawnNode = (position: { x: number; y: number }): ChatNode =>
    adopt(makeNode(position, { focusDraft: true, color: nextColor(), updatedAt: Date.now() }))

  const spawnNote = (position: { x: number; y: number }): NoteNode => {
    const node = adopt(
      makeNoteNode(position, { focusDraft: true, color: nextColor(), updatedAt: Date.now() })
    )
    // The note's file exists from the moment the node does — main allocates
    // a unique "Untitled" filename at the folder root.
    void window.api.note.create(node.id)
    return node
  }

  // Guarantee the one persistent CLAUDE.md node is present. A no-op when it
  // already is (the common reload path — main injects it into the doc for
  // pre-feature canvases). When absent (a brand-new folder), synthesize it with
  // the fixed id and ensure its root file exists.
  const ensureClaudeMd = (nodes: CanvasNode[]): CanvasNode[] => {
    if (nodes.some((n) => isNote(n) && n.data.system === 'claudeMd')) return nodes
    const node: NoteNode = {
      ...makeNoteNode(CLAUDE_MD_POS, { title: 'CLAUDE.md', system: 'claudeMd' }),
      id: CLAUDE_MD_ID
    }
    void window.api.note.create(CLAUDE_MD_ID)
    return [node, ...nodes]
  }

  // Write the layout immediately rather than through the 500ms debounce —
  // used where a quick app close right after the change must not drop it.
  const persistNow = (): void => {
    clearTimeout(saveTimer)
    saveTimer = undefined
    if (get().loaded) void window.api.canvas.save(buildDoc())
  }

  return {
    set,
    get,
    patchData,
    buildDoc,
    persist,
    persistNow,
    persistThread,
    flushNoteSave,
    flushNoteSaves,
    flushSave,
    switchFolder,
    anyStreaming,
    applyGravity,
    isClaudeMd,
    transcriptBlock,
    withPageContent,
    dispatchTurn,
    adopt,
    nextColor,
    placeFile,
    spawnNode,
    spawnNote,
    ensureClaudeMd,
    computerTargetFor,
    growTabForComputer,
    spawnComputerTab,
    awaitComputerTab
  }
}

export type StoreCtx = ReturnType<typeof createStoreHelpers>
