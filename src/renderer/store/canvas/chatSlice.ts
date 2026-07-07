import type { ContextFile, ForkRef, PersistedEdge } from '@shared/types'
import { contrastColorId } from '@renderer/lib/palette'
import {
  DERIVE_GAP,
  EST_NODE_H,
  NODE_W,
  boxOf,
  findForkSpot,
  hostTitle,
  isChat,
  isFile,
  isLabel,
  isLink,
  isNote,
  isWidget,
  makeNode,
  makeNoteNode,
  uid,
  viewportFitHeight
} from './model'
import type { CanvasNode, Message } from './model'
import type { CanvasState } from './state'
import { generateTitle, titleFromText } from './titling'
import type { StoreCtx } from './helpers'
import { pendingGravitySeeds } from './runtime'

export function createChatSlice(
  ctx: StoreCtx
): Pick<
  CanvasState,
  | 'toggleComputer'
  | 'toggleResearch'
  | 'respondPermission'
  | 'forkChat'
  | 'forkWithDraft'
  | 'deriveNote'
  | 'addContextEdge'
  | 'removeContextEdge'
  | 'chatAbout'
  | 'send'
  | 'retry'
> {
  const {
    set,
    get,
    patchData,
    persist,
    persistThread,
    transcriptBlock,
    withPageContent,
    dispatchTurn,
    spawnNode,
    computerTargetFor,
    growTabForComputer,
    spawnComputerTab,
    awaitComputerTab
  } = ctx
  return {
    toggleComputer: (id) => {
      const node = get().nodes.find((n) => n.id === id)
      if (node && isChat(node)) patchData(id, { computerArmed: !node.data.computerArmed })
    },

    toggleResearch: (id) => {
      const node = get().nodes.find((n) => n.id === id)
      if (node && isChat(node)) patchData(id, { researchArmed: !node.data.researchArmed })
    },

    respondPermission: (id, requestId, allow) => {
      const node = get().nodes.find((n) => n.id === id)
      if (!node || isFile(node) || isLink(node) || isLabel(node)) return
      if (node.data.pendingPermission?.requestId !== requestId) return
      // Dismiss immediately; main echoes a permission-resolved event regardless.
      patchData(id, { pendingPermission: undefined })
      window.api.thread.respondPermission({ requestId, allow })
    },

    forkChat: (nodeId, at) => {
      const parent = get().nodes.find((n) => n.id === nodeId)
      if (!parent || !isChat(parent)) return null
      // Fork-ahead only: the anchor is always the chat's tip — its latest
      // *settled* assistant reply. Mid-stream the in-flight reply has no uuid
      // yet, so forking while the parent streams branches from the prior turn
      // (already persisted, so the fork is safe). Forking again later anchors on
      // the new tip, and several forks of the same tip share an anchor message.
      const anchor = [...parent.data.messages]
        .reverse()
        .find((m) => m.role === 'assistant' && m.uuid)
      const sessionId = parent.data.sessionId
      if (!anchor?.uuid || !sessionId) return null

      // The forked session carries the parent's context up to the anchor —
      // the node's transcript starts clean and shows only what diverges.
      const node = makeNode(at ?? findForkSpot(parent), {
        // Start untitled like a fresh chat; the title is generated from the
        // fork's own first message rather than inherited from the parent.
        color: parent.data.color, // forks stay in the parent's color family
        status: 'idle',
        growthCap: parent.data.growthCap,
        focusDraft: true,
        updatedAt: Date.now(),
        forkOf: { sessionId, messageUuid: anchor.uuid },
        // the forked session inherits the parent's transcript — and with it,
        // any files already injected there
        injectedImages: parent.data.injectedImages
      })
      const edge: PersistedEdge = {
        id: uid(),
        source: parent.id,
        target: node.id,
        sourceMessageId: anchor.id
      }
      // Selection moves with the keyboard (like adopt): without it the fork's
      // transcript won't scroll — useForwardedWheel pans the canvas instead.
      set((s) => ({
        nodes: [
          ...s.nodes.map((n) => (n.selected ? { ...n, selected: false } : n)),
          { ...node, selected: true }
        ],
        edges: [...s.edges, edge]
      }))
      persist()
      pendingGravitySeeds.add(node.id)
      return node.id
    },

    forkWithDraft: (sourceId, draft) => {
      const src = get().nodes.find((n) => n.id === sourceId)
      if (!src) return null
      // A chat forks at its tip (transcript carries the quoted passage as
      // context); a note/file/link spawns a fresh chat wired to read it. Both
      // helpers auto-place the new card just right of the source with its
      // composer focused, so the seeded draft is ready to type under. Nothing
      // sends until the user does — the pending fork is consumed by first send.
      const newId = isChat(src)
        ? get().forkChat(sourceId)
        : isNote(src) || isFile(src) || isLink(src)
          ? get().chatAbout(sourceId)
          : null
      if (!newId) return null
      get().setDraft(newId, draft)
      return newId
    },

    // Generalizes the old "distill chat → note": works from any node, with a
    // free-form instruction, and leaves a visible derive edge behind. A chat
    // source forks its session at the tip (full context, images, and prompt
    // cache ride along for free); a document source feeds the note turn as
    // context the same way it would feed a chat. The output is always a note.
    deriveNote: async (sourceId, instruction, inPlace = false) => {
      const source = get().nodes.find((n) => n.id === sourceId)
      const text = instruction.trim()
      if (!source || !text) return null
      // Don't fork a chat mid-stream — its tip isn't settled yet.
      if (isChat(source) && source.data.status === 'streaming') return null

      // Edit-in-place: rewrite the source note itself instead of deriving a
      // new one. The editing turn connects to the source note's own file, so
      // the prior content snapshots into its history and the rewrite lands as
      // a new version (visible via the pager) — no new node, no edge.
      if (inPlace && isNote(source)) {
        if (source.data.status === 'streaming') return null
        patchData(sourceId, {
          status: 'streaming',
          growthCap: viewportFitHeight(get().viewport.zoom),
          viewVersion: undefined, // an editing turn always lands on the live content
          updatedAt: Date.now()
        })
        void window.api.thread.send({
          nodeId: sourceId,
          text,
          model: get().model,
          effort: get().effort,
          kind: 'note',
          noteTitle: source.data.title || 'Untitled note'
        })
        return sourceId
      }

      // A chat source rides a session fork when it has a forkable tip; without
      // one (empty chat, a research transcript with no session) its transcript
      // is serialized into a context block instead.
      const chatSource = isChat(source)
      let forkFrom: ForkRef | undefined
      if (chatSource) {
        const anchor = [...source.data.messages]
          .reverse()
          .find((m) => m.role === 'assistant' && m.uuid)
        if (anchor?.uuid && source.data.sessionId) {
          forkFrom = { sessionId: source.data.sessionId, messageUuid: anchor.uuid }
        }
      }

      // Right of the source, same level — deliberately plain placement
      // (overlapping a neighbor is fine). Spawned unselected: sharing a
      // selection with the source would make React Flow drag them as a unit.
      const p = boxOf(source)
      const node = makeNoteNode(
        { x: p.x + p.w + DERIVE_GAP, y: p.y },
        {
          // Left untitled: the note shows a "…" placeholder while it streams and
          // gets a real title from its content once the turn lands (see the
          // thread-event handler) — never the raw instruction.
          title: '',
          // The note wears the wrapper's color — a palette color chosen to
          // differ from the source, so it reads as derived-from but distinct.
          color: contrastColorId(source.data.color),
          status: 'streaming',
          growthCap: viewportFitHeight(get().viewport.zoom),
          updatedAt: Date.now()
        }
      )
      set((st) => ({
        nodes: [...st.nodes, node],
        edges: [
          ...st.edges,
          { id: uid(), source: sourceId, target: node.id, kind: 'derive' as const }
        ]
      }))
      persist()
      pendingGravitySeeds.add(node.id)

      // The editing turn writes by node id, so the file can stay "Untitled"
      // (create allocates it, suffixing to dodge collisions); once the turn
      // finishes, generateTitle renames it to match the generated title.
      await window.api.note.create(node.id)
      const noteTitle = 'Untitled note'

      // Build the document feed (a chat source rides forkFrom instead).
      const contextNotes: { id: string; title: string; content: string }[] = []
      const contextFiles: ContextFile[] = []
      if (!chatSource && isNote(source)) {
        contextNotes.push({
          id: source.id,
          title: source.data.title || 'Untitled note',
          content: source.data.content
        })
      } else if (!chatSource && isFile(source) && source.data.file) {
        contextFiles.push({
          id: source.id,
          title:
            source.data.title || (source.data.kind === 'pdf' ? 'Untitled PDF' : 'Untitled image'),
          file: source.data.file,
          isNew: true
        })
      } else if (chatSource && !forkFrom) {
        // No forkable session — hand the transcript over as a context block.
        const transcript = transcriptBlock(source)
        if (transcript) {
          contextNotes.push({
            id: source.id,
            title: source.data.title || 'Chat',
            content: transcript
          })
        }
      }

      void (async () => {
        const contextLinks =
          !chatSource && isLink(source) && source.data.url
            ? await withPageContent([
                {
                  id: source.id,
                  title: source.data.title || hostTitle(source.data.url) || 'Untitled link',
                  url: source.data.url
                }
              ])
            : []
        void window.api.thread.send({
          nodeId: node.id,
          text,
          model: get().model,
          effort: get().effort,
          kind: 'note',
          noteTitle,
          ...(forkFrom ? { forkFrom } : {}),
          ...(contextNotes.length > 0 ? { contextNotes } : {}),
          ...(contextFiles.length > 0 ? { contextFiles } : {}),
          ...(contextLinks.length > 0 ? { contextLinks } : {})
        })
      })()
      return node.id
    },

    addContextEdge: (sourceId, chatId) => {
      // THE connection creator. Connections are undirected — either argument
      // order lands the same wire (source/target only record how it was
      // drawn). Valid pairs must include at least one chat (a note wired to a
      // note would mean nothing): chat—note/file/link/chat. Research chats are
      // display-only and connect to nothing; labels never connect.
      const s = get()
      const a = s.nodes.find((n) => n.id === sourceId)
      const b = s.nodes.find((n) => n.id === chatId)
      if (!a || !b || sourceId === chatId) return
      const connectable = (n: CanvasNode): boolean =>
        isNote(n) ||
        isFile(n) ||
        isLink(n) ||
        isWidget(n) ||
        (isChat(n) && n.data.kind !== 'research')
      if (!connectable(a) || !connectable(b)) return
      // MVP scope: a widget's one counterparty is a chat — the wire feeds the
      // widget's HTML into the chat's context and authorizes prompt messages
      // back. The at-least-one-chat rule below therefore also covers widgets
      // (a widget⟷tab/note/file pair has no chat and is refused).
      if (!isChat(a) && !isChat(b)) return
      if (
        s.edges.some(
          (e) =>
            (e.kind === 'context' || e.kind === 'output') &&
            ((e.source === sourceId && e.target === chatId) ||
              (e.source === chatId && e.target === sourceId))
        )
      )
        return // already connected (in either drawn direction)
      set((st) => ({
        edges: [...st.edges, { id: uid(), source: sourceId, target: chatId, kind: 'context' }]
      }))
      persist()
    },

    removeContextEdge: (edgeId) => {
      set((s) => ({ edges: s.edges.filter((e) => e.id !== edgeId) }))
      persist()
    },

    chatAbout: (sourceId, center) => {
      // "Chat about this" from the half-sheet: spawn a fresh chat wired as
      // context (resource → chat), so the reading panel stays put on the doc
      // while the new chat opens with its composer focused on the live canvas
      // beside it. Any readable resource — note, file, or link (not a chat).
      // With `center`, drop the chat centered on that flow-space point (the
      // panel's chat button passes the middle of the visible canvas); else
      // fall back to just right of the source's card.
      const src = get().nodes.find((n) => n.id === sourceId)
      if (!src || !(isNote(src) || isFile(src) || isLink(src))) return null
      const pos = center
        ? { x: center.x - NODE_W / 2, y: center.y - EST_NODE_H / 2 }
        : (() => {
            const p = boxOf(src)
            return { x: p.x + p.w + DERIVE_GAP, y: p.y }
          })()
      const chat = spawnNode(pos)
      get().addContextEdge(sourceId, chat.id)
      return chat.id
    },

    send: (id) => {
      const node = get().nodes.find((n) => n.id === id)
      if (!node || !isChat(node) || node.data.status === 'streaming') return
      const text = node.data.draft.trim()
      if (!text) return

      // Computer use needs a wired, live tab — without one, spawn a fresh tab
      // just left of the chat and wire it, so asking a bare chat to browse
      // just works. The turn dispatches once the tab's guest attaches.
      const computer = node.data.computerArmed ? computerTargetFor(id) : null
      const spawnedTab = node.data.computerArmed && !computer ? spawnComputerTab(node) : null
      // Give the driven tab a desktop viewport before the turn's first
      // screenshot — the resize lands in the DOM long before the agent looks.
      if (computer) growTabForComputer(computer.targetId)

      const userMsg: Message = { id: uid(), role: 'user', text }
      const assistantMsg: Message = { id: uid(), role: 'assistant', text: '' }
      // Sized to the screen at send time so the reply never grows past the
      // viewport — once the node hits the cap, the transcript scrolls instead.
      const growthCap = viewportFitHeight(get().viewport.zoom)
      set((s) => ({
        nodes: s.nodes.map((n) =>
          n.id === id
            ? ({
                ...n,
                // release any fixed height so the node grows with the reply (up to the cap)
                height: undefined,
                data: {
                  ...n.data,
                  messages: [...node.data.messages, userMsg, assistantMsg],
                  draft: '',
                  status: 'streaming' as const,
                  growthCap,
                  updatedAt: Date.now(),
                  lastError: undefined, // a fresh send supersedes any failed turn
                  // title is left as-is: an unnamed chat shows a "…" placeholder
                  // while generateTitle (kicked off below) names it from this
                  // message in the background — never the raw prompt verbatim.
                  researchArmed: false // one-shot: research applies to this send only
                }
              } as CanvasNode)
            : n
        )
      }))
      persist() // title may have changed
      persistThread(id) // the user message is part of the durable transcript now

      // Name a still-unnamed chat from the user's message right away — no need
      // to wait for the reply to land. A user rename (before or during the
      // background title turn) always wins.
      if (!node.data.title && node.data.kind !== 'research') {
        generateTitle(id, `User: ${text.slice(0, 1500)}`, titleFromText(text), false)
      }

      if (spawnedTab) {
        void awaitComputerTab(spawnedTab).then((target) =>
          dispatchTurn(node, text, { research: node.data.researchArmed, computer: target })
        )
      } else {
        dispatchTurn(node, text, { research: node.data.researchArmed, computer })
      }
    },

    // Re-run a failed turn: same prompt, same session. The session resume may
    // already hold the failed turn's partial output — acceptable; the retry
    // prompt repeats and the model answers fresh.
    retry: (id) => {
      const node = get().nodes.find((n) => n.id === id)
      if (!node || !isChat(node) || node.data.status !== 'error') return
      const lastUser = [...node.data.messages].reverse().find((m) => m.role === 'user')
      if (!lastUser) return

      // Stream into the failed turn's bubble: reuse a trailing assistant
      // message, or add a fresh placeholder if the turn died before one landed.
      const last = node.data.messages[node.data.messages.length - 1]
      const messages: Message[] =
        last && last.role === 'assistant'
          ? [...node.data.messages.slice(0, -1), { ...last, text: '' }]
          : [...node.data.messages, { id: uid(), role: 'assistant', text: '' }]

      const growthCap = viewportFitHeight(get().viewport.zoom)
      set((s) => ({
        nodes: s.nodes.map((n) =>
          n.id === id
            ? ({
                ...n,
                height: undefined,
                data: {
                  ...n.data,
                  messages,
                  status: 'streaming' as const,
                  growthCap,
                  updatedAt: Date.now(),
                  lastError: undefined
                }
              } as CanvasNode)
            : n
        )
      }))

      // Retry repeats the last prompt on the same session; research never
      // re-arms here (it was a one-shot on the original send). Computer use is
      // sticky, so a still-armed chat retries with its tab — if the tab died,
      // the retry just runs without it and the model says so.
      const computer = node.data.computerArmed ? computerTargetFor(id) : null
      if (computer) growTabForComputer(computer.targetId)
      dispatchTurn(node, lastUser.text, { computer })
    }
  }
}
