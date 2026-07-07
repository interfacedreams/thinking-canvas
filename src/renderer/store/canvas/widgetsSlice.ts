import type { PersistedEdge } from '@shared/types'
import {
  GAP,
  KNOB_CLEARANCE,
  boxOf,
  isChat,
  isWidget,
  makeWidgetNode,
  uid,
  widgetFrame
} from './model'
import type { CanvasNode } from './model'
import type { CanvasState } from './state'
import type { StoreCtx } from './helpers'
import { pendingGravitySeeds } from './runtime'

// The widget message bus, MVP scope: widgets talk to CHATS and nothing else.
// A widget is a sandboxed iframe whose only voice is postMessage
// (window.canvas.send in the bridge shim); WidgetNodeView validates and
// rate-limits each message, then hands it here. Routing runs along the node's
// ordinary context edges — an edge is the authorization to message — one hop,
// and the only accepted type is:
//   chat: prompt {text — sends a real user turn}
// (Tab routing — seek/play/navigate — and widget→widget data existed briefly
// and were cut 2026-07-06 to keep the MVP surface minimal; the chat remains
// the widget's one counterparty, in both directions.)

const asText = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() ? v.slice(0, 8_000) : null

export function createWidgetsSlice(
  ctx: StoreCtx
): Pick<CanvasState, 'addWidgetFromAgent' | 'applyWidgetUpdate' | 'routeWidgetMessage'> {
  const { set, get, patchData, persist, nextColor } = ctx

  // The bus peers of a node — same attachment-edge walk as helpers.peersOf.
  const peersOf = (id: string): CanvasNode[] =>
    get().edges.flatMap((e) => {
      if (e.kind !== 'context' && e.kind !== 'output') return []
      const peerId = e.source === id ? e.target : e.target === id ? e.source : null
      const n = peerId ? get().nodes.find((x) => x.id === peerId) : null
      return n ? [n] : []
    })

  return {
    // A create_widget tool call landed (main already persisted the HTML) —
    // materialize the card just right of its chat, wired to that chat alone.
    addWidgetFromAgent: (chatId, w) => {
      const chat = get().nodes.find((n) => n.id === chatId)
      if (!chat || get().nodes.some((n) => n.id === w.widgetId)) return
      const p = boxOf(chat)
      const node = {
        ...makeWidgetNode(
          { x: p.x + p.w + KNOB_CLEARANCE + GAP, y: p.y },
          widgetFrame({ width: w.width, height: w.height }),
          {
            title: w.title,
            color: nextColor(),
            html: w.html,
            rev: 0,
            sourceChatId: chatId,
            updatedAt: Date.now()
          }
        ),
        id: w.widgetId
      }
      const wire: PersistedEdge = { id: uid(), source: node.id, target: chatId, kind: 'context' }
      set((s) => ({ nodes: [...s.nodes, node], edges: [...s.edges, wire] }))
      persist()
      pendingGravitySeeds.add(node.id)
    },

    // update_widget rewrote the HTML on disk — mirror it and bump rev so the
    // iframe remounts on the fresh document.
    applyWidgetUpdate: (widgetId, patch) => {
      const node = get().nodes.find((n) => n.id === widgetId)
      if (!node || !isWidget(node)) return
      patchData(widgetId, {
        html: patch.html,
        rev: (node.data.rev ?? 0) + 1,
        ...(patch.title ? { title: patch.title } : {}),
        updatedAt: Date.now()
      })
      persist()
    },

    routeWidgetMessage: (widgetId, msg) => {
      if (msg.type !== 'prompt') return
      const text = asText(msg.text)
      if (!text) return
      for (const peer of peersOf(widgetId)) {
        if (!isChat(peer) || peer.data.kind === 'research') continue
        if (peer.data.status === 'streaming') continue
        // Borrow the composer for the send, then give back whatever the
        // user had half-typed (send clears the draft).
        const parked = peer.data.draft
        get().setDraft(peer.id, text)
        get().send(peer.id)
        if (parked.trim()) get().setDraft(peer.id, parked)
      }
    }
  }
}
