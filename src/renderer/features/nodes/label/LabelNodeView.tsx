import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { NodeResizeControl, ResizeControlVariant, type NodeProps } from '@xyflow/react'
import { Trash2 } from 'lucide-react'
import {
  useCanvasStore,
  MAX_NODE_H,
  MIN_LABEL_H,
  MIN_LABEL_W,
  type LabelNode
} from '@renderer/store/canvas'

// The editable-state indicator and selection ring.
const BLUE = '#3B82F6'
// Breathing room between the text and the box edge (matches the box's padding).
const PAD = 10
const MIN_FONT = 8
const MAX_FONT = 256
const RESIZE_LIMITS = { minWidth: MIN_LABEL_W, minHeight: MIN_LABEL_H, maxHeight: MAX_NODE_H }

/**
 * Grow-to-fill: binary-search the largest font size at which the text — wrapped
 * by the box's width (native CSS) — still fits the box's height and width. The
 * box's size is the only size control, so this re-runs on every resize and edit.
 */
function fitFont(box: HTMLElement, text: HTMLElement): void {
  const availW = box.clientWidth - 2 * PAD
  const availH = box.clientHeight - 2 * PAD
  if (availW <= 0 || availH <= 0) return
  if (!text.textContent?.trim()) {
    text.style.fontSize = '24px' // empty label: a sensible caret size
    return
  }
  let lo = MIN_FONT
  let hi = MAX_FONT
  for (let i = 0; i < 18; i++) {
    const mid = (lo + hi) / 2
    text.style.fontSize = `${mid}px`
    const fits = text.scrollHeight <= availH && text.scrollWidth <= availW
    if (fits) lo = mid
    else hi = mid
  }
  text.style.fontSize = `${lo}px`
}

function LabelNodeView({ id, data, selected }: NodeProps<LabelNode>): React.JSX.Element {
  const setTitle = useCanvasStore((s) => s.setTitle)
  const deleteChat = useCanvasStore((s) => s.deleteChat)
  const clearFocusDraft = useCanvasStore((s) => s.clearFocusDraft)

  const boxRef = useRef<HTMLDivElement>(null)
  const textRef = useRef<HTMLDivElement>(null)

  // A freshly spawned label opens straight into edit mode. State adjustment
  // happens during render (not an effect), the same as NoteNodeView's rename.
  const [editing, setEditing] = useState(false)
  if (data.focusDraft && !editing) setEditing(true)

  // Keep the (uncontrolled) editable in sync with the stored text while it's
  // not being typed into, then re-fit. Editing leaves the DOM untouched so the
  // caret never jumps.
  useLayoutEffect(() => {
    const box = boxRef.current
    const text = textRef.current
    if (!box || !text) return
    if (!editing && text.innerText !== data.title) text.innerText = data.title
    fitFont(box, text)
  }, [data.title, editing])

  // Re-fit whenever the box is resized (the user dragging a handle).
  useEffect(() => {
    const box = boxRef.current
    const text = textRef.current
    if (!box || !text) return
    const ro = new ResizeObserver(() => fitFont(box, text))
    ro.observe(box)
    return () => ro.disconnect()
  }, [])

  // Focus the editable when edit mode opens, selecting all so a re-type
  // replaces cleanly. A fresh node mounts `visibility: hidden` until React Flow
  // measures it, and focus() on a hidden element is ignored — retry every frame
  // until it sticks, then consume the focusDraft flag (mirrors NoteNodeView).
  useEffect(() => {
    if (!editing) return
    let raf = 0
    const tryFocus = (): void => {
      const text = textRef.current
      if (!text) return
      text.focus()
      if (document.activeElement === text) {
        const range = document.createRange()
        range.selectNodeContents(text)
        const sel = window.getSelection()
        sel?.removeAllRanges()
        sel?.addRange(range)
        if (useCanvasStore.getState().nodes.some((n) => n.id === id && n.data.focusDraft)) {
          clearFocusDraft(id)
        }
      } else {
        raf = requestAnimationFrame(tryFocus)
      }
    }
    tryFocus()
    return () => cancelAnimationFrame(raf)
  }, [editing, clearFocusDraft, id])

  const commit = (): void => {
    setEditing(false)
    const next = textRef.current?.innerText ?? ''
    if (next !== data.title) setTitle(id, next)
  }

  const showFrame = selected || editing

  return (
    <div
      ref={boxRef}
      onDoubleClick={() => setEditing(true)}
      className={`relative flex h-full w-full items-center justify-center rounded-[8px] ${
        editing ? 'nodrag' : ''
      }`}
      style={{
        padding: PAD,
        border: `2px solid ${showFrame ? BLUE : 'transparent'}`,
        background: editing ? '#3B82F60D' : 'transparent'
      }}
    >
      {/* The text itself: native CSS wraps it to the box width; fitFont sets the
          size. Editable only while editing, so a single click still drags. */}
      <div
        ref={textRef}
        contentEditable={editing}
        suppressContentEditableWarning
        spellCheck={false}
        data-placeholder="Label"
        onInput={() => {
          const box = boxRef.current
          const text = textRef.current
          if (box && text) fitFont(box, text)
        }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            e.stopPropagation()
            commit()
          }
        }}
        className={`label-text max-h-full w-full overflow-hidden leading-[1.15] font-medium outline-none ${
          editing ? 'nodrag cursor-text' : 'cursor-grab'
        }`}
        style={{ textAlign: 'center', whiteSpace: 'pre-wrap', overflowWrap: 'break-word' }}
      />

      {/* Resize handles (right / bottom / corner), shown only when selected —
          dragging them resizes the box, which re-fits the font. */}
      {selected && !editing && (
        <>
          <NodeResizeControl
            position="right"
            variant={ResizeControlVariant.Line}
            {...RESIZE_LIMITS}
            style={{ borderColor: 'transparent', borderWidth: 5 }}
          />
          <NodeResizeControl
            position="bottom"
            variant={ResizeControlVariant.Line}
            {...RESIZE_LIMITS}
            style={{ borderColor: 'transparent', borderWidth: 5 }}
          />
          <NodeResizeControl
            position="bottom-right"
            {...RESIZE_LIMITS}
            style={{
              background: 'transparent',
              border: 'none',
              width: 16,
              height: 16,
              cursor: 'nwse-resize'
            }}
          />
        </>
      )}

      {/* Delete affordance — labels have no header, so it floats just above the
          box's top-right on selection. Hover deepens the fill (no red), matching
          the node-header trash buttons. Direct delete (no confirm modal): a
          label holds no transcript or edges to cascade. */}
      {selected && !editing && (
        <button
          type="button"
          title="Delete label"
          onClick={(e) => {
            e.stopPropagation()
            deleteChat(id, false)
          }}
          className="nodrag absolute right-0 bottom-full mb-1 flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg border border-neutral-300 bg-neutral-100 p-1 text-neutral-600 shadow-md transition-colors hover:bg-neutral-200"
        >
          <Trash2 className="h-5 w-5" />
        </button>
      )}
    </div>
  )
}

export default memo(LabelNodeView)
