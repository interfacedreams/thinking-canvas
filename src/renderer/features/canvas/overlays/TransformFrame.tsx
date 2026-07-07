import { useEffect, useRef, useState } from 'react'
import TextareaAutosize from 'react-textarea-autosize'
import { ArrowUp, X } from 'lucide-react'
import { useCanvasStore, isNote } from '@renderer/store/canvas'
import { contrastColorId, paletteFor } from '@renderer/lib/palette'

/**
 * Transform mode's visible wrap: a colored header tab behind the node carrying
 * a one-shot composer, all inside a dashed outline. The tab sits above the node
 * (the command bar: a white input box + an × to cancel) and tucks a little way
 * under the node's top so the two connect with no seam — it does NOT wrap the
 * node's sides or bottom. Sending runs deriveNote — the source feeds an
 * instruction and a fresh note appears to the right.
 *
 * Layering, back to front: the header tab background (z -2) → the node's opaque
 * paper fill (z -1, an explicit layer inside the card) → the node content. The
 * tab sits a step deeper than the card fill, so everywhere the two overlap the
 * card paints over the wrapper, leaving only the protruding rim and the command
 * bar above the node. (The card root carries `isolate`, so these negative z
 * values stay contained to the node and never slip behind neighbors.) The dashed
 * outline rides z -1 too, but its border lives in the rim outside the card fill,
 * so it stays visible. The command controls alone ride a positive z so they stay
 * on top of the bar.
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
const INPUT_ROW = 50 // the textarea row beneath the header (flow px)
const HEADER = 48 // header band — mirrors the node header below (px-3 py-1.5 + h-9 chip)
const TUCK = 20 // how far the tab extends down behind the node's top
// The armed node is also selected, so it wears its 2px focus ring — sit the
// dashed frame just outside that ring (3px out) on the sides and bottom, so the
// dash's inner edge clears the ring instead of touching it.
const DASH = 5
// Pull the frame in 1px on each side so the outer width sits a touch narrower
// than the full DASH rim — the sides tuck a hair closer to the card.
const SIDE = DASH - 1
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
  const controlsRef = useRef<HTMLDivElement>(null)

  // The wrapper previews the outcome's color: editing in place keeps the result
  // in THIS note (its own color); deriving picks a contrast color, the one the
  // new note will wear.
  const wrap = paletteFor(inPlace ? sourceColor : contrastColorId(sourceColor))
  const bar = HEADER + INPUT_ROW
  // The command bar's live height: `bar` while the draft is one line, taller as
  // the textarea grows. The bar is bottom-anchored to the node's top so growth
  // extends upward; the tab background and dashed outline (top-anchored, so
  // they can tuck under / wrap the node) follow this measurement.
  const [barH, setBarH] = useState(bar)

  // Pull the keyboard in once mounted (a fresh arm = a fresh mount).
  useEffect(() => {
    const t = setTimeout(() => textareaRef.current?.focus(), 0)
    return () => clearTimeout(t)
  }, [])

  useEffect(() => {
    const el = controlsRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setBarH(el.offsetHeight))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const canSend = draft.trim().length > 0
  const submit = (): void => {
    if (!canSend) return
    void deriveNote(id, draft.trim(), inPlace)
    setTransforming(null)
  }

  // cancel — the same chip shape/size as the header chrome (h-9, translucent
  // edge fill, accent on hover), in the wrapper palette. Sits at the header's
  // left, mirroring the node's minimize chip.
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
      {/* the header tab background — rises `bar` px above the node and tucks TUCK
          px under its top. z -2 keeps it behind the card's opaque fill (z -1),
          so the card covers the tucked-under part, leaving only the command bar
          above. */}
      <div
        className="nodrag"
        style={{
          position: 'absolute',
          top: -barH,
          left: -SIDE,
          right: -SIDE,
          height: barH + TUCK,
          zIndex: -2,
          background: wrap.bg,
          borderTopLeftRadius: OUTER_RADIUS,
          borderTopRightRadius: OUTER_RADIUS,
          pointerEvents: 'none'
        }}
      />
      {/* the command controls, laid over the tab: a header band that mirrors
          the node's own header (same height, chip button, line underneath),
          with the textarea row beneath it. */}
      <div
        ref={controlsRef}
        className="nodrag nowheel"
        style={{
          position: 'absolute',
          bottom: '100%',
          left: -SIDE,
          right: -SIDE,
          minHeight: bar,
          zIndex: 12,
          display: 'flex',
          flexDirection: 'column'
        }}
      >
        {/* header band — same px-3 py-1.5 + h-9 chrome as the node header below,
            with a line underneath. Cancel sits at the left like the node's
            minimize chip; "Transform →" reads as the title. Note sources also
            carry the target toggle (new note / this note): both segments stay
            visible and the active one fills white — new note derives a fresh
            note, this note rewrites this one in place (a new version in its
            history). The wrapper color tracks the choice. */}
        <div
          className="flex items-center gap-2 px-3 py-1.5"
          style={{ borderBottom: `1px solid ${wrap.edge}` }}
        >
          {cancelBtn}
          <span style={{ fontSize: 23, fontWeight: 500, color: wrap.deep, opacity: 0.85 }}>
            Transform →
          </span>
          {/* Non-note sources can only ever derive a fresh note, so there's no
              choice to offer — show a single static "new note" target that wears
              the same look as the active segment of the note toggle below. */}
          {!sourceIsNote && (
            <div
              style={{
                display: 'inline-flex',
                padding: 3,
                borderRadius: 9,
                background: wrap.edge
              }}
            >
              <span
                className="rounded-md px-3 py-1"
                style={{
                  fontSize: 15,
                  background: '#FFFFFF',
                  color: wrap.deep,
                  fontWeight: 600
                }}
              >
                new note
              </span>
            </div>
          )}
          {sourceIsNote && (
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
                      fontSize: 15,
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
          )}
        </div>
        {/* the input row: the white box with the send bee, full width */}
        <div
          style={{
            flex: 1,
            minHeight: INPUT_ROW,
            display: 'flex',
            alignItems: 'center',
            padding: '8px 12px'
          }}
        >
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
              className="flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center self-end rounded-full text-white transition-all hover:scale-110 active:scale-95 disabled:cursor-default disabled:opacity-30"
              style={{ background: wrap.accent, margin: '5px 4px' }}
            >
              <ArrowUp className="h-4 w-4" />
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
          top: -barH,
          left: -SIDE,
          right: -SIDE,
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
