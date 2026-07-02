/* eslint-disable react-refresh/only-export-components -- a shared markdown
   helper module: the link component ships beside its context and the
   `components` map that consumers hand to react-markdown, not on its own. */
import { createContext, useContext } from 'react'
import type { Components } from 'react-markdown'
import { useCanvasStore } from '@renderer/store/canvas'

// The node whose body is rendering this markdown — so a link clicked inside it
// can spawn its tab next to that node. Empty when rendered outside a node.
export const MarkdownSourceContext = createContext<string>('')

const isHttp = (href: string): boolean => /^https?:\/\//i.test(href)

/**
 * A link inside an AI message or note body. Plain anchors would navigate the
 * whole BrowserWindow (Electron has no tab chrome to land on), nuking the app.
 * Instead, an http(s) link opens as a tab in the half-sheet panel — read it
 * beside the canvas — and anything else (mailto:, etc.) goes to the OS browser.
 */
function MarkdownLink({
  href,
  children
}: {
  href?: string
  children?: React.ReactNode
}): React.JSX.Element {
  const sourceId = useContext(MarkdownSourceContext)
  return (
    <a
      href={href}
      onClick={(e) => {
        if (!href) return
        e.preventDefault()
        if (isHttp(href)) useCanvasStore.getState().openLinkInPanel(href, sourceId)
        // window.open is denied in main and handed to shell.openExternal —
        // the right home for mailto:, tel:, and other non-web schemes.
        else window.open(href, '_blank')
      }}
    >
      {children}
    </a>
  )
}

// Drop-in `components` for react-markdown that reroutes link clicks.
export const markdownComponents: Components = { a: MarkdownLink }
