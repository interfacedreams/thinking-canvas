// Debounced per-note autosave of live content (keystrokes → the note's file).
export const noteSaveTimers = new Map<string, ReturnType<typeof setTimeout>>()
// Debounced per-note index-description regeneration (pinned notes only).
export const describeTimers = new Map<string, ReturnType<typeof setTimeout>>()
// File ids riding the in-flight turn as image/document blocks, per chat node.
// Marked injected only when the turn lands ok — a failed turn re-sends them
// on retry.
export const pendingFileInjections = new Map<string, string[]>()
