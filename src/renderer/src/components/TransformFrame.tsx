import { useEffect, useRef, useState } from 'react'
import TextareaAutosize from 'react-textarea-autosize'
import { X } from 'lucide-react'
import { useCanvasStore, isNote } from '../store/canvas'
import { contrastColorId, paletteFor } from '../lib/palette'
import BeeIcon from './BeeIcon'

/**
 * Transform mode's visible wrap: a colored header tab behind the node carrying
 * a one-shot composer, all inside a dashed outline. The tab sits above the node
 * (the command bar: a white input box + an × to cancel) and tucks a little way
 * under the node's top so the two connect with no seam — it does NOT wrap the
 * node's sides or bottom. Sending runs deriveNote — the source feeds an
 * instruction and a fresh note appears to the right.
 *
 * Layering, back to front: the whole wrapper (header tab background + dashed
 * outline) → the node. The wrapper sits a negative z-index behind the node,
 * which is opaque, so only the protruding rim and the command bar above the
 * node show; everywhere the two overlap, the node card covers the wrapper.
 * (The card root carries `isolate`, so this negative z stays contained to the
 * node and never slips behind neighbors.) The command controls alone ride a
 * positive z so they stay on top of the bar.
 *
 * The wrapper color previews where the result lands. Deriving a new note: the
 * frame wears a palette color chosen to differ from the source (contrastColorId)
 * — the color the spawned note will wear. Editing this note in place (the
 * "This note" toggle, note sources only): the frame wears the source note's own
 * color, since the rewrite stays in this card.
 *
 * Renders inside the node card's root (which is `relative`), so it tracks the
 * node automatically. Returns null unless this node is the one armed; the
 * composer is a child so it mounts fresh (empty draft, focused) on each arm.
 */

const RADIUS = 14 // matches the card's rounded-[14px]
const BAR = 50 // header height for the single-line input row (flow px)
const TOGGLE_ROW = 58 // the target toggle strip above the input (note sources only)
const TUCK = 20 // how far the tab extends down behind the node's top
// The armed node is also selected, so it wears its 2px focus ring — sit the
// dashed frame just outside that ring (2px out) on the sides and bottom.
const DASH = 4
const OUTER_RADIUS = RADIUS + DASH // frame/tab corners

function TransformComposer({ id }: { id: string }): React.JSX.Element {
  const setTransforming = useCanvasStore((s) => s.setTransforming)
  const deriveNote = useCanvasStore((s) => s.deriveNote)
  const sourceColor = useCanvasStore((s) => s.nodes.find((n) => n.id === id)?.data.color)
  // Only a note can be rewritten in place; every other source can only derive.
  const sourceIsNote = useCanvasStore((s) => {
    const n = s.nodes.find((x) => x.id === id)
    return !!n && isNote(n)
  })
  const [draft, setDraft] = useState('')
  // Where the result lands: false → a fresh note alongside (default), true →
  // rewrite this note in place. Offered for note sources only.
  const [inPlace, setInPlace] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // The wrapper previews the outcome's color: editing in place keeps the result
  // in THIS note (its own color); deriving picks a contrast color, the one the
  // new note will wear.
  const wrap = paletteFor(inPlace ? sourceColor : contrastColorId(sourceColor))
  const bar = sourceIsNote ? BAR + TOGGLE_ROW : BAR

  // Pull the keyboard in once mounted (a fresh arm = a fresh mount).
  useEffect(() => {
    const t = setTimeout(() => textareaRef.current?.focus(), 0)
    return () => clearTimeout(t)
  }, [])

  const canSend = draft.trim().length > 0
  const submit = (): void => {
    if (!canSend) return
    void deriveNote(id, draft.trim(), inPlace)
    setTransforming(null)
  }

  // cancel — the same chip shape/size as the header chrome (h-9, translucent
  // edge fill, accent on hover), in the wrapper palette. Lives in the toggle
  // row for notes, the input row otherwise.
  const cancelBtn = (
    <button
      type="button"
      onClick={() => setTransforming(null)}
      title="Cancel transform (Esc)"
      className="nodrag flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-lg bg-(--wc-chip) text-(--wc-deep) transition-colors hover:bg-(--wc-accent)"
      style={
        {
          '--wc-chip': `${wrap.edge}99`,
          '--wc-deep': wrap.deep,
          '--wc-accent': wrap.accent
        } as React.CSSProperties
      }
    >
      <X className="h-[25px] w-[25px]" />
    </button>
  )

  return (
    <>
      {/* the header tab background — rises BAR px above the node and tucks TUCK
          px under its top. A negative z keeps it behind the node, so the card
          covers the tucked-under part, leaving only the command bar above. */}
      <div
        className="nodrag"
        style={{
          position: 'absolute',
          top: -bar,
          left: -DASH,
          right: -DASH,
          height: bar + TUCK,
          zIndex: -1,
          background: wrap.bg,
          borderTopLeftRadius: OUTER_RADIUS,
          borderTopRightRadius: OUTER_RADIUS,
          pointerEvents: 'none'
        }}
      />
      {/* the command controls, laid over the tab. A note source gets a target
          toggle strip stacked above the input row; other sources show the
          input row alone. */}
      <div
        className="nodrag nowheel"
        style={{
          position: 'absolute',
          top: -bar,
          left: -DASH,
          right: -DASH,
          minHeight: bar,
          zIndex: 12,
          display: 'flex',
          flexDirection: 'column'
        }}
      >
        {/* target toggle — only for notes. Reads as a centered sentence,
            "Transform →" + a segmented toggle whose two segments (new note /
            this note) are both always visible; the active one fills white. New
            note derives a fresh note; this note rewrites this one in place (a
            new version in its history). The wrapper color tracks the choice. */}
        {sourceIsNote && (
          <div
            style={{
              position: 'relative',
              height: TOGGLE_ROW,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 10,
              padding: '12px 8px 0',
              fontSize: 19,
              fontWeight: 500,
              color: wrap.deep
            }}
          >
            {/* cancel sits at the row's left; the sentence stays centered */}
            <div style={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)' }}>
              {cancelBtn}
            </div>
            <span style={{ opacity: 0.75 }}>Transform →</span>
            <div
              style={{
                display: 'inline-flex',
                gap: 2,
                padding: 3,
                borderRadius: 9,
                background: wrap.edge
              }}
            >
              {[
                { val: false, label: 'new note' },
                { val: true, label: 'this note' }
              ].map((opt) => {
                const active = inPlace === opt.val
                return (
                  <button
                    key={opt.label}
                    type="button"
                    onClick={() => setInPlace(opt.val)}
                    className="nodrag cursor-pointer rounded-md px-3 py-1 transition-colors"
                    style={{
                      fontSize: 19,
                      background: active ? '#FFFFFF' : 'transparent',
                      color: wrap.deep,
                      fontWeight: active ? 600 : 500,
                      opacity: active ? 1 : 0.7
                    }}
                  >
                    {opt.label}
                  </button>
                )
              })}
            </div>
          </div>
        )}
        {/* the input row: the white input box with the send bee. For notes the
            cancel ✕ lives up in the toggle row, so the input spans full width. */}
        <div
          style={{
            flex: 1,
            minHeight: BAR,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '6px 8px'
          }}
        >
          {!sourceIsNote && cancelBtn}
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
              title={inPlace ? 'Rewrite this note (Enter)' : 'Transform into a note (Enter)'}
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
      </div>
      {/* the dashed outline — behind the node (negative z) so the card sits on
          top of it; only the rim that protrudes past the node's focus ring
          shows. Never intercepts clicks. */}
      <div
        className="nodrag"
        style={{
          position: 'absolute',
          top: -bar,
          left: -DASH,
          right: -DASH,
          bottom: -DASH,
          zIndex: -1,
          border: `2px dashed ${wrap.accent}`,
          borderRadius: OUTER_RADIUS,
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
