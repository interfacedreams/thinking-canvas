import { useToastStore } from '@renderer/ui/toastStore'
import { isChat, isFile, isLabel, isLink, isNote, uid } from './model'
import type { CanvasNode } from './model'
import { useCanvasStore } from './store'
import { generateTitle, titleFromText } from './titling'
import { noteSaveTimers, pendingFileInjections } from './runtime'

// Researchers running right now: `${leadNodeId}:${toolUseId}` → {parentId, msgId} in lead.
// Mid-turn only, so it lives outside the store (no re-renders, never persisted).
const researchChildren = new Map<string, { parentId: string; msgId: string }>()
// Tab being driven by an in-flight computer-use turn, per chat node — set on
// the turn's first computer action, cleared (and the tab's `driven` badge
// dropped) when the turn settles. Mid-turn only, so it lives outside the store.
const drivenTabs = new Map<string, string>()

// Stream events from the main process (one Agent SDK query per turn, any number of
// nodes streaming concurrently). Registered once at module load.
window.api.thread.onEvent((event) => {
  const { setState } = useCanvasStore
  const patch = (id: string, fn: (node: CanvasNode) => Record<string, unknown>): void => {
    setState((s) => ({
      nodes: s.nodes.map((n) =>
        n.id === id ? ({ ...n, data: { ...n.data, ...fn(n) } } as CanvasNode) : n
      )
    }))
  }

  if (event.type === 'session' && event.sessionId) {
    // The fork (if any) has materialized into its own session — drop the pending ref.
    patch(event.nodeId, () => ({ sessionId: event.sessionId, forkOf: undefined }))
    useCanvasStore.getState().persistSoon()
  } else if (event.type === 'delta' && event.text) {
    patch(event.nodeId, (node) => {
      // Note turns route the assistant's commentary into the reply strip.
      if (isNote(node)) return { lastReply: (node.data.lastReply ?? '') + event.text }
      if (!isChat(node)) return {}
      const last = node.data.messages[node.data.messages.length - 1]
      if (!last || last.role !== 'assistant') return {}
      // Never glue text into a status chip (research/computer) — text that
      // resumes after a chip opens a fresh bubble instead.
      if (last.kind) {
        return {
          messages: [...node.data.messages, { id: uid(), role: 'assistant', text: event.text }]
        }
      }
      return {
        messages: [...node.data.messages.slice(0, -1), { ...last, text: last.text + event.text }]
      }
    })
  } else if (event.type === 'computer-action') {
    // Light up the driven tab: badge + animated drive wire until the turn
    // settles ('done' clears it via drivenTabs).
    if (drivenTabs.get(event.nodeId) !== event.targetId) {
      drivenTabs.set(event.nodeId, event.targetId)
      patch(event.targetId, (node) => (isLink(node) ? { driven: true } : {}))
    }
    // One live chip per contiguous run of browser actions: consecutive actions
    // replace the chip's text (with a running step count from main) instead of
    // stacking one transcript line per click. A trailing empty assistant
    // placeholder stays last so the turn's text keeps streaming into it.
    patch(event.nodeId, (node) => {
      if (!isChat(node)) return {}
      const msgs = node.data.messages
      const tail = msgs[msgs.length - 1]
      const keepTail = tail && tail.role === 'assistant' && !tail.kind && tail.text === ''
      const body = keepTail ? msgs.slice(0, -1) : [...msgs]
      const prev = body[body.length - 1]
      const next =
        prev && prev.kind === 'computer-action'
          ? [...body.slice(0, -1), { ...prev, text: event.text }]
          : [
              ...body,
              {
                id: uid(),
                role: 'assistant' as const,
                text: event.text,
                kind: 'computer-action' as const
              }
            ]
      return { messages: keepTail ? [...next, tail] : next }
    })
  } else if (event.type === 'spawn') {
    // The lead called the Agent tool — show an inline status chip in the parent chat.
    const msgId = uid()
    researchChildren.set(`${event.nodeId}:${event.toolUseId}`, {
      parentId: event.nodeId,
      msgId
    })
    patch(event.nodeId, (node) => {
      if (!isChat(node)) return {}
      return {
        messages: [
          ...node.data.messages,
          {
            id: msgId,
            role: 'assistant' as const,
            text: event.description,
            kind: 'research-spawn' as const
          }
        ]
      }
    })
  } else if (event.type === 'childDelta') {
    // Researcher content stays inside the lead's turn — drop streaming deltas.
  } else if (event.type === 'childDone') {
    const key = `${event.nodeId}:${event.toolUseId}`
    const entry = researchChildren.get(key)
    researchChildren.delete(key)
    if (entry) {
      patch(entry.parentId, (node) => {
        if (!isChat(node)) return {}
        return {
          messages: node.data.messages.map((m) =>
            m.id === entry.msgId ? { ...m, kind: 'research-done' as const } : m
          )
        }
      })
    }
  } else if (event.type === 'note-content') {
    patch(event.nodeId, (node) =>
      isNote(node)
        ? { content: event.content, ...(event.versions ? { versions: event.versions } : {}) }
        : {}
    )
  } else if (event.type === 'note-external-edit') {
    // Something edited this note's file behind the card — a chat turn, or any
    // on-disk change the main process's folder watcher spotted. If the user
    // has unsaved edits in it (a pending autosave), park the new content
    // behind a "Reload" prompt instead of clobbering their work; otherwise
    // adopt it and refresh history.
    const store = useCanvasStore.getState()
    const node = store.nodes.find((n) => n.id === event.nodeId)
    if (!node || !isNote(node)) return
    // Disk already matches the card (the watcher echoing a write the app made
    // itself): nothing to adopt — at most take the refreshed history.
    if (event.content === node.data.content && !node.data.externalEdit) {
      if (event.versions) {
        const versions = event.versions
        patch(event.nodeId, () => ({ versions }))
      }
      return
    }
    if (noteSaveTimers.has(event.nodeId) || node.data.status === 'streaming') {
      patch(event.nodeId, () => ({ externalEdit: { content: event.content } }))
    } else {
      patch(event.nodeId, () => ({
        content: event.content,
        externalEdit: undefined,
        updatedAt: Date.now(),
        ...(event.versions ? { versions: event.versions } : {})
      }))
      store.persistSoon()
      if (node.data.pinned) store.scheduleDescribe(event.nodeId)
    }
  } else if (event.type === 'permission') {
    patch(event.nodeId, () => ({ pendingPermission: event.request }))
  } else if (event.type === 'permission-resolved') {
    patch(event.nodeId, (node) =>
      !isFile(node) &&
      !isLink(node) &&
      !isLabel(node) &&
      node.data.pendingPermission?.requestId === event.requestId
        ? { pendingPermission: undefined }
        : {}
    )
  } else if (event.type === 'done') {
    // No credentials: the turn never ran. Surface it as a toast (like an
    // unsupported drop) and quietly revert the node — no error strip, no Retry.
    if (event.needsAuth) {
      useToastStore
        .getState()
        .show(event.error ?? 'Set up a Claude token in Settings to start chatting.')
      patch(event.nodeId, (node) => {
        if (!isChat(node)) return { status: 'idle', pendingPermission: undefined }
        const last = node.data.messages[node.data.messages.length - 1]
        return {
          status: 'idle',
          lastError: undefined,
          pendingPermission: undefined,
          // drop the empty assistant placeholder this turn would have filled
          messages:
            last && last.role === 'assistant' && last.text === ''
              ? node.data.messages.slice(0, -1)
              : node.data.messages
        }
      })
      return
    }
    // The turn settled — the driven tab (if any) is free again.
    const drivenTab = drivenTabs.get(event.nodeId)
    if (drivenTab) {
      drivenTabs.delete(event.nodeId)
      patch(drivenTab, (node) => (isLink(node) ? { driven: false } : {}))
    }
    // Safety sweep: a turn that errored mid-research leaves no childDone — settle any
    // still-pending inline research chips.
    for (const [key, entry] of researchChildren) {
      if (key.startsWith(`${event.nodeId}:`)) {
        researchChildren.delete(key)
        patch(entry.parentId, (node) => {
          if (!isChat(node)) return {}
          return {
            messages: node.data.messages.map((m) =>
              m.id === entry.msgId ? { ...m, kind: 'research-done' as const } : m
            )
          }
        })
      }
    }
    // Files that rode this turn are in the session now (only if it landed —
    // a failed turn's files go again on retry).
    const injectedNow = event.ok ? pendingFileInjections.get(event.nodeId) : undefined
    pendingFileInjections.delete(event.nodeId)
    patch(event.nodeId, (node) => {
      if (isNote(node)) {
        const warning = event.ok === false ? `\n\n⚠️ ${event.error ?? 'The agent run failed.'}` : ''
        return {
          status: 'idle',
          pendingPermission: undefined,
          updatedAt: Date.now(),
          viewVersion: undefined, // land back on the live content after the turn
          ...(event.usage ? { lastUsage: event.usage } : {}),
          // adopt the turn's settled content + version history
          ...(event.note
            ? {
                content: event.note.content,
                ...(event.note.versions ? { versions: event.note.versions } : {})
              }
            : {}),
          ...(warning ? { lastReply: (node.data.lastReply ?? '') + warning } : {})
        }
      }
      if (!isChat(node)) return {}
      const last = node.data.messages[node.data.messages.length - 1]
      if (event.ok === false) {
        return {
          status: 'error', // the error strip (with Retry) takes it from here
          lastError: event.error ?? 'The turn failed.',
          pendingPermission: undefined,
          ...(event.usage ? { lastUsage: event.usage } : {}),
          // drop an untouched placeholder; keep whatever partial text streamed
          messages:
            last && last.role === 'assistant' && last.text === ''
              ? node.data.messages.slice(0, -1)
              : node.data.messages
        }
      }
      return {
        status: 'idle',
        lastError: undefined,
        pendingPermission: undefined, // safety net if the turn dies mid-prompt
        updatedAt: Date.now(),
        ...(event.usage ? { lastUsage: event.usage } : {}),
        ...(injectedNow?.length
          ? {
              injectedImages: [...new Set([...(node.data.injectedImages ?? []), ...injectedNow])]
            }
          : {}),
        messages:
          last && last.role === 'assistant'
            ? [
                ...node.data.messages.slice(0, -1),
                // stamp the SDK uuid — it's the anchor that makes this message forkable
                { ...last, ...(event.messageUuid ? { uuid: event.messageUuid } : {}) }
              ]
            : node.data.messages
      }
    })
    useCanvasStore.getState().persistThread(event.nodeId)
    // updatedAt (and injectedImages) round-trip through canvas.json — make them durable.
    useCanvasStore.getState().persistSoon()

    // An editing turn changed a pinned note — refresh its index description.
    if (event.ok && event.note) {
      const node = useCanvasStore.getState().nodes.find((n) => n.id === event.nodeId)
      if (node && isNote(node) && node.data.pinned) {
        useCanvasStore.getState().scheduleDescribe(event.nodeId)
      }
    }

    // A turn extended a pinned chat — re-snapshot its transcript clip (and blurb)
    // so memory reflects the conversation as it is now, not when it was pinned.
    if (event.ok) {
      const node = useCanvasStore.getState().nodes.find((n) => n.id === event.nodeId)
      if (node && isChat(node) && node.data.pinned) {
        useCanvasStore.getState().refreshChatMemory(event.nodeId)
      }
    }

    // A turn landed on a still-unnamed note: name it from a one-shot Haiku
    // turn in the background, from its content. Until that returns the node
    // shows a "…" placeholder; a user rename (before or during) always wins.
    // (Chats are named at send time — see `send` — not here.)
    if (event.ok) {
      const node = useCanvasStore.getState().nodes.find((n) => n.id === event.nodeId)
      if (node && !node.data.title && isNote(node) && node.data.content) {
        generateTitle(
          event.nodeId,
          node.data.content.slice(0, 3000),
          titleFromText(node.data.content),
          true
        )
      }
      // Output notes a chat writes via an output port receive their content
      // through note-content events but never a turn-complete of their own —
      // name them off the chat's completed turn so they don't strand on "…".
      if (node && isChat(node)) {
        const store = useCanvasStore.getState()
        for (const edge of store.edges) {
          if (edge.kind !== 'output' || edge.source !== event.nodeId) continue
          const out = store.nodes.find((n) => n.id === edge.target)
          if (out && isNote(out) && !out.data.title && out.data.content) {
            generateTitle(
              out.id,
              out.data.content.slice(0, 3000),
              titleFromText(out.data.content),
              true
            )
          }
        }
      }
    }
  }
})
