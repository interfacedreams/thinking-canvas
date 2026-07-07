// Debounced per-note autosave of live content (keystrokes → the note's file).
export const noteSaveTimers = new Map<string, ReturnType<typeof setTimeout>>()
// Debounced per-note index-description regeneration (pinned notes only).
export const describeTimers = new Map<string, ReturnType<typeof setTimeout>>()
// File ids riding the in-flight turn as image/document blocks, per chat node.
// Marked injected only when the turn lands ok — a failed turn re-sends them
// on retry.
export const pendingFileInjections = new Map<string, string[]>()
// Newborn nodes whose gravity push waits for their first real measurement.
// Pushing at spawn time would use the 360px height estimate — an empty note
// is ~110px shorter, so the estimate shoves the neighbor below way too far
// and leaves a dead band under the newborn. One frame later React Flow
// reports the true size and onNodesChange runs the push with it.
export const pendingGravitySeeds = new Set<string>()
