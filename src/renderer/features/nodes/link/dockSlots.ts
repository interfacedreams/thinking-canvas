// Slot registry for driven-tab picture-in-picture docks (see DrivenDock).
// Docked tabs form a grid anchored at the bottom-right corner: slot 0 is the
// corner, slots fill upward, then wrap into the next column to the left.
// Module-level because docks live in separate LinkNodeView trees; the
// subscription lets every dock re-pin when another claims or releases a slot.

type Listener = () => void

const order: string[] = []
const listeners = new Set<Listener>()
const notify = (): void => listeners.forEach((l) => l())

export const dockSlots = {
  /** Claim a slot (no-op if already held). */
  claim(id: string): void {
    if (!order.includes(id)) {
      order.push(id)
      notify()
    }
  },
  /** Release a slot; later docks compact toward the corner. */
  release(id: string): void {
    const i = order.indexOf(id)
    if (i >= 0) {
      order.splice(i, 1)
      notify()
    }
  },
  /** This id's slot index, or -1 while undocked. */
  index(id: string): number {
    return order.indexOf(id)
  },
  subscribe(fn: Listener): () => void {
    listeners.add(fn)
    return () => listeners.delete(fn)
  }
}
