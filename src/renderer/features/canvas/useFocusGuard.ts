import { useEffect } from 'react'
import { useCanvasStore, isLink } from '@renderer/store/canvas'

// Chromium hands a <webview> element the embedder's focus whenever its guest
// page takes focus — including from the synthesized clicks of a computer-use
// turn — and it does so WITHOUT firing any focus event on the element, so the
// steal itself is invisible to listeners. Two detectors, both scoped to tabs
// that are currently `driven` (deliberate focus of other tabs is untouched):
//
// 1. Fast path: the element LOSING focus does fire `focusout`. On the next
//    task, if focus landed on a driven tab's webview, hand it straight back —
//    the user's caret returns within a millisecond of an agent click.
// 2. Safety net: a short poll for steals with no focusout at all (nothing was
//    focused beforehand, or the guest re-stole between events).
//
// Hold: key presses (and fallback typing) DO need the guest to hold browser-
// side focus for a few dozen milliseconds — main juggles focus for them (see
// withGuestFocus in main/computerUse.ts) and brackets the juggle with
// computer:focusHold events so the guard doesn't yank focus mid-input. On
// release the guard restores whatever the user had.
const POLL_MS = 50

// The preload channel is a bare ipcRenderer.on with no way to unsubscribe, so
// register once per window, not once per mount.
let holdListenerBound = false
let held = false

export function useFocusGuard(): void {
  useEffect(() => {
    const isDrivenWebview = (el: Element | null): boolean => {
      if (!el || el.tagName !== 'WEBVIEW') return false
      const nodeId = el.closest('.react-flow__node')?.getAttribute('data-id')
      return (
        !!nodeId &&
        useCanvasStore
          .getState()
          .nodes.some((n) => n.id === nodeId && isLink(n) && n.data.driven)
      )
    }

    // Last element the user genuinely had focused — the restore target.
    let lastGood: Element | null =
      document.activeElement && document.activeElement.tagName !== 'WEBVIEW'
        ? document.activeElement
        : null

    // If a driven webview holds focus, give it back to `to` (or drop it).
    const restore = (to: Element | null): void => {
      if (held) return
      // App inactive (user is in another application): there is no caret here
      // to protect, and calling focus() in an inactive window asks macOS to
      // ACTIVATE the app — the cross-app focus steal. Stand down; the window
      // focus listener below reclaims the caret when the user returns.
      if (!document.hasFocus()) return
      const a = document.activeElement
      if (!(a instanceof HTMLElement) || !isDrivenWebview(a)) return
      if (
        to instanceof HTMLElement &&
        to.isConnected &&
        to !== document.body &&
        !isDrivenWebview(to)
      ) {
        to.focus()
      } else {
        a.blur()
      }
    }

    if (!holdListenerBound) {
      holdListenerBound = true
      window.api.computer.onFocusHold((h) => {
        held = h
        // The juggle is over — the steal it needed is no longer welcome.
        if (!h) window.setTimeout(() => restore(lastGood), 0)
      })
    }

    const onFocusOut = (e: FocusEvent): void => {
      const from = e.target instanceof Element ? e.target : null
      if (from && from.tagName !== 'WEBVIEW') lastGood = from
      window.setTimeout(() => restore(from), 0)
    }
    document.addEventListener('focusout', onFocusOut, true)

    // Coming back to the app: if a driven tab grabbed focus while we were
    // away (the guard stands down when inactive), hand the caret back now.
    const onWindowFocus = (): void => {
      window.setTimeout(() => restore(lastGood), 0)
    }
    window.addEventListener('focus', onWindowFocus)

    let prev: Element | null = document.activeElement
    const timer = window.setInterval(() => {
      if (held) return
      const a = document.activeElement
      // App inactive: accept whatever focus state exists (nothing to protect,
      // and restore() would refuse anyway) instead of re-detecting the same
      // steal every tick. The window focus listener reclaims on return.
      if (!document.hasFocus()) {
        prev = a
        return
      }
      if (a !== prev && isDrivenWebview(a)) {
        restore(prev) // keep prev — repeated steals restore the same element
      } else {
        prev = a
        if (a && a.tagName !== 'WEBVIEW' && a !== document.body) lastGood = a
      }
    }, POLL_MS)

    return () => {
      document.removeEventListener('focusout', onFocusOut, true)
      window.removeEventListener('focus', onWindowFocus)
      window.clearInterval(timer)
    }
  }, [])
}
