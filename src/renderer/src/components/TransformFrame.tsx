import { useEffect, useRef, useState } from 'react'
import TextareaAutosize from 'react-textarea-autosize'
import { X } from 'lucide-react'
import { useCanvasStore } from '../store/canvas'
import BeeIcon from './BeeIcon'

/**
 * Transform mode's visible wrap: one dashed-outlined unit around the node and a
 * command strip above it, read as a single temporary frame. The strip up top
 * carries the transform color (a cool purple, deliberately unlike any node
 * palette) with a white input box and an × to cancel; below it the node shows
 * through untouched. Sending runs deriveNote — the source feeds an instruction
 * and a fresh note appears to the right.
 *
 * Renders inside the node card's root (which is `relative`), so it tracks the
 * node automatically. Returns null unless this node is the one armed; the
 * composer is a child so it mounts fresh (empty draft, focused) on each arm.
 */

const ACCENT = '#7C6FBF' // the dashed outline
const STRIP = '#E7E2F7' // the light-purple command strip
const RADIUS = 14 // matches the card's rounded-[14px]
const BAR = 50 // strip height for a single-line input (flow px)
// The armed node is also selected, so it wears its 2px focus ring — sit the
// dashed frame just outside that ring on the sides and bottom.
const GAP = 4

function TransformComposer({ id }: { id: string }): React.JSX.Element {
  const setTransforming = useCanvasStore((s) => s.setTransforming)
  const deriveNote = useCanvasStore((s) => s.deriveNote)
  const [draft, setDraft] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Pull the keyboard in once mounted (a fresh arm = a fresh mount).
  useEffect(() => {
    const t = setTimeout(() => textareaRef.current?.focus(), 0)
    return () => clearTimeout(t)
  }, [])

  const canSend = draft.trim().length > 0
  const submit = (): void => {
    if (!canSend) return
    void deriveNote(id, draft.trim())
    setTransforming(null)
  }

  return (
    <>
      {/* the command strip — spans the full frame width and sits entirely above
          the node (never over it), so no transform color touches the card */}
      <div
        className="nodrag nowheel"
        style={{
          position: 'absolute',
          top: -BAR,
          left: -GAP,
          right: -GAP,
          minHeight: BAR,
          zIndex: 10,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          background: STRIP,
          borderTopLeftRadius: RADIUS,
          borderTopRightRadius: RADIUS,
          padding: '6px 8px'
        }}
      >
        {/* cancel — the header chip style, just smaller, in the transform palette */}
        <button
          type="button"
          onClick={() => setTransforming(null)}
          title="Cancel transform (Esc)"
          className="nodrag flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-lg bg-[#D8D1F0] text-[#473C82] transition-colors hover:bg-[#C7BCEC]"
        >
          <X className="h-[18px] w-[18px]" />
        </button>
        {/* the white input box — full width, with the send bee tucked inside it */}
        <div
          style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            background: '#FFFFFF',
            border: '1px solid rgba(0,0,0,0.12)',
            borderRadius: 8,
            padding: '0 4px 0 10px'
          }}
        >
          <TextareaAutosize
            ref={textareaRef}
            value={draft}
            minRows={1}
            maxRows={6}
            placeholder="Summarize, extract, rewrite…"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                submit()
              } else if (e.key === 'Escape') {
                e.preventDefault()
                setTransforming(null)
              }
            }}
            style={{
              flex: 1,
              resize: 'none',
              background: 'transparent',
              border: 'none',
              outline: 'none',
              fontSize: 15,
              lineHeight: '22px',
              color: '#1F2937',
              padding: '7px 0'
            }}
          />
          <button
            type="button"
            onClick={submit}
            disabled={!canSend}
            title="Transform into a note (Enter)"
            style={{
              flexShrink: 0,
              background: 'transparent',
              border: 'none',
              padding: 2,
              opacity: canSend ? 1 : 0.3,
              cursor: canSend ? 'pointer' : 'default'
            }}
          >
            <BeeIcon className="h-6 w-6" />
          </button>
        </div>
      </div>
      {/* one dashed outline tracing the whole unit (strip + node), sitting just
          outside the node's focus ring; never intercepts clicks */}
      <div
        className="nodrag"
        style={{
          position: 'absolute',
          top: -BAR,
          left: -GAP,
          right: -GAP,
          bottom: -GAP,
          zIndex: 11,
          border: `2px dashed ${ACCENT}`,
          borderRadius: RADIUS,
          pointerEvents: 'none'
        }}
      />
    </>
  )
}

export default function TransformFrame({ id }: { id: string }): React.JSX.Element | null {
  const armed = useCanvasStore((s) => s.transforming === id)
  if (!armed) return null
  return <TransformComposer id={id} />
}
