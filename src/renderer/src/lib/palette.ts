// Muted post-it palette for chat nodes. Each entry derives every tint a node
// needs: body fill, chrome (dividers/buttons), hover/selection accent, and the
// deep tone used for title text and icons.

export interface NodePalette {
  id: string
  label: string
  bg: string // node body fill
  edge: string // header divider, chip buttons, swatches
  accent: string // hover states, selection ring, fork edge stroke
  deep: string // title/icon color
}

export const PALETTE: NodePalette[] = [
  {
    id: 'butter',
    label: 'Butter',
    bg: '#FEF3C7',
    edge: '#EDD27E',
    accent: '#E2BF52',
    deep: '#92690B'
  },
  {
    id: 'peach',
    label: 'Peach',
    bg: '#FDE7D2',
    edge: '#F0C49C',
    accent: '#E6AC76',
    deep: '#99551A'
  },
  { id: 'rose', label: 'Rose', bg: '#FBE3E7', edge: '#EFBAC6', accent: '#E398AB', deep: '#A04965' },
  {
    id: 'lavender',
    label: 'Lavender',
    bg: '#EFE9FA',
    edge: '#D5C6EF',
    accent: '#BFA7E5',
    deep: '#6C50A4'
  },
  { id: 'sky', label: 'Sky', bg: '#E1EFFA', edge: '#B5D6EE', accent: '#8FBEE3', deep: '#2F6593' },
  { id: 'mint', label: 'Mint', bg: '#DFF3EC', edge: '#AFDFCC', accent: '#85CDB2', deep: '#1F7257' },
  { id: 'sage', label: 'Sage', bg: '#EAF2D9', edge: '#CCDFA4', accent: '#B2CE7E', deep: '#5A7222' },
  {
    id: 'stone',
    label: 'Stone',
    bg: '#F1EEE7',
    edge: '#D8D2C2',
    accent: '#C0B7A1',
    deep: '#6E6450'
  }
]

export function paletteFor(id?: string): NodePalette {
  return PALETTE.find((p) => p.id === id) ?? PALETTE[0]
}

/** Cycle: the color after `prevId`, or the default (butter) when starting fresh. */
export function nextColorId(prevId?: string): string {
  if (!prevId) return PALETTE[0].id
  const i = PALETTE.findIndex((p) => p.id === prevId)
  return PALETTE[(i + 1) % PALETTE.length].id
}

/** A palette color guaranteed different from `sourceId`, picked across the ring
 *  for visible contrast. Used for the transform wrapper and the note it spawns,
 *  so the new note reads as related to — but distinct from — its source. */
export function contrastColorId(sourceId?: string): string {
  const i = PALETTE.findIndex((p) => p.id === (sourceId ?? PALETTE[0].id))
  return PALETTE[((i < 0 ? 0 : i) + 4) % PALETTE.length].id
}
