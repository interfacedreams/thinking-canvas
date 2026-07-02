import { DEFAULT_EFFORT, DEFAULT_MODEL, EFFORT_OPTIONS, MODEL_OPTIONS } from '@shared/types'
import type { EffortId, ModelId } from '@shared/types'

// Reads the current key, falling back to the pre-rename `bee-claude:*` key so
// a saved preference survives the app rename. (The migrated userData dir brings
// the old localStorage entries along; this picks them up the first time.)
export function loadPref(key: string, legacyKey: string): string | null {
  return localStorage.getItem(key) ?? localStorage.getItem(legacyKey)
}

// Model choice is an app-wide preference, not part of any one canvas —
// it lives in localStorage rather than canvas.json.
export const MODEL_STORAGE_KEY = 'thinking-canvas:model'
export function loadModel(): ModelId {
  const saved = loadPref(MODEL_STORAGE_KEY, 'bee-claude:model')
  return MODEL_OPTIONS.some((m) => m.id === saved) ? (saved as ModelId) : DEFAULT_MODEL
}

// Thinking effort is an app-wide preference too — same localStorage home.
export const EFFORT_STORAGE_KEY = 'thinking-canvas:effort'
export function loadEffort(): EffortId {
  const saved = loadPref(EFFORT_STORAGE_KEY, 'bee-claude:effort')
  return EFFORT_OPTIONS.some((e) => e.id === saved) ? (saved as EffortId) : DEFAULT_EFFORT
}
