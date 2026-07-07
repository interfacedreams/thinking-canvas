import { GAP, KNOB_CLEARANCE, boxOf, isLabel } from './model'
import type { CanvasNode } from './model'

// Gravity auto layout — really collision push, not gravity: cards are rigid
// bodies with personal space, and the only thing that ever moves one is
// another card physically displacing it. The seed (the card just placed,
// dropped, or grown) never moves; everything it truly overlaps is pushed out
// to GAP clearance, and pushed cards push their own neighbors in turn. An
// arrangement with no overlaps never shifts — the solver is idempotent, so
// it can't fight the user's layout, only make room in it.

export type GravityBias = 'radial' | 'down'

type XY = { x: number; y: number }

interface Box {
  id: string
  x: number
  y: number
  w: number
  h: number
}

/**
 * Resolve overlaps outward from the seed cards. Returns the final position of
 * every card that had to move (empty map when everything already fits).
 *
 * The trigger is a real intersection — a card sitting clear but closer than
 * GAP is left alone ("if it fits, nothing changes") — but a push separates to
 * full GAP clearance, so displaced cards land with the same breathing room a
 * fresh spawn gets. Collision runs on knob-inclusive boxes: the connection
 * knob pokes KNOB_CLEARANCE past the card's top and right edges, and it's
 * part of the card as far as physics goes — otherwise a "resolved" layout
 * leaves knobs buried under neighbors, and vertical gaps read tighter than
 * horizontal ones.
 *
 * bias 'radial' (placement, drop): each overlapper moves along whichever axis
 * gets it clear soonest, away from the pusher. bias 'down' (content growth):
 * a card below the grower is pushed straight down — a chat streams its reply
 * downward, so the room it takes should read as downward too.
 */
export function resolveCollisions(
  nodes: CanvasNode[],
  seedIds: ReadonlySet<string>,
  bias: GravityBias
): Map<string, XY> {
  // Labels sit out entirely — they float above the cards as annotations and
  // are often deliberately placed on top of things.
  // Boxes are knob-inclusive: grown upward and rightward by KNOB_CLEARANCE
  // (positions convert back when a move is recorded).
  const boxes: Box[] = nodes
    .filter((n) => !isLabel(n))
    .map((n) => {
      const b = boxOf(n)
      return {
        id: n.id,
        x: b.x,
        y: b.y - KNOB_CLEARANCE,
        w: b.w + KNOB_CLEARANCE,
        h: b.h + KNOB_CLEARANCE
      }
    })
  const byId = new Map(boxes.map((b) => [b.id, b]))
  const seeds = [...seedIds].filter((id) => byId.has(id))
  const seedBoxes = seeds.map((id) => byId.get(id)!)
  const moved = new Map<string, XY>()

  // Push b clear of a along one axis. False when they don't truly overlap
  // (sub-pixel contact doesn't count).
  const push = (a: Box, b: Box): boolean => {
    const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
    const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
    if (ox <= 1 || oy <= 1) return false
    const rightward = b.x + b.w / 2 >= a.x + a.w / 2
    const downward = b.y + b.h / 2 >= a.y + a.h / 2
    const dx = rightward ? a.x + a.w + GAP - b.x : -(b.x + b.w + GAP - a.x)
    const dy = downward ? a.y + a.h + GAP - b.y : -(b.y + b.h + GAP - a.y)
    if (bias === 'down' && downward) b.y += dy
    else if (Math.abs(dx) <= Math.abs(dy)) b.x += dx
    else b.y += dy
    moved.set(b.id, { x: b.x, y: b.y + KNOB_CLEARANCE }) // back to node coords
    return true
  }

  // Outward wave: every pushed card becomes a pusher until nothing overlaps.
  // Pushes strictly separate, so the wave converges; the budget is a backstop
  // against a pathological packing, not a tuning knob.
  const queue = [...seeds]
  let budget = 600
  while (queue.length > 0 && budget-- > 0) {
    const a = byId.get(queue.shift()!)
    if (!a) continue
    // A pushed card that landed on a seed moves itself off — seeds never move.
    if (!seedIds.has(a.id)) {
      for (const s of seedBoxes) if (push(s, a)) queue.push(a.id)
    }
    for (const b of boxes) {
      if (b.id === a.id || seedIds.has(b.id)) continue
      if (push(a, b)) queue.push(b.id)
    }
  }
  return moved
}

// ---------------------------------------------------------------------------
// Animation: pushed cards glide to their spots (~200ms ease-out) instead of
// teleporting — that's what makes a push read as physics instead of a glitch.
// One animation at a time; a fresh pass snaps the prior one to its end state
// first (settleMoves) so no card is ever stranded half-pushed.

const ANIM_MS = 200
let raf = 0
let inFlight: Map<string, XY> | null = null

/** Finish any in-flight glide instantly. Call before solving a new pass so
 *  the solver reads settled positions, never mid-glide ones. */
export function settleMoves(apply: (positions: Map<string, XY>) => void): void {
  if (!inFlight) return
  cancelAnimationFrame(raf)
  const finals = inFlight
  inFlight = null
  apply(finals)
}

export function animateMoves(
  from: Map<string, XY>,
  to: Map<string, XY>,
  apply: (positions: Map<string, XY>) => void,
  done: () => void
): void {
  cancelAnimationFrame(raf)
  inFlight = to
  const t0 = performance.now()
  const easeOutCubic = (t: number): number => 1 - Math.pow(1 - t, 3)
  const frame = (now: number): void => {
    const t = Math.min(1, (now - t0) / ANIM_MS)
    const k = easeOutCubic(t)
    const positions = new Map<string, XY>()
    for (const [id, end] of to) {
      const start = from.get(id) ?? end
      positions.set(id, { x: start.x + (end.x - start.x) * k, y: start.y + (end.y - start.y) * k })
    }
    apply(positions)
    if (t < 1) {
      raf = requestAnimationFrame(frame)
    } else {
      inFlight = null
      done()
    }
  }
  raf = requestAnimationFrame(frame)
}
