import { sep } from 'path'

// The Agent SDK spawns a native CLI binary that ships in a per-platform
// package (@anthropic-ai/claude-agent-sdk-<platform>-<arch>). Its own resolver
// does no asar handling: in a packaged app it returns the path *inside*
// app.asar, which can't be exec'd — the OS walks the path, hits the app.asar
// file where it expects a directory, and fails with ENOTDIR. We resolve the
// binary ourselves and redirect to the asarUnpack'd copy so it's a real,
// spawnable file. Returns undefined if no platform package is installed (dev
// fallback: let the SDK resolve its default).
export let claudeExecCache: string | null | undefined
export function claudeExecutable(): string | undefined {
  if (claudeExecCache !== undefined) return claudeExecCache ?? undefined
  const bin = process.platform === 'win32' ? 'claude.exe' : 'claude'
  const base = '@anthropic-ai/claude-agent-sdk'
  // Linux ships both glibc and musl builds — try glibc first, then musl.
  const candidates =
    process.platform === 'linux'
      ? [`${base}-linux-${process.arch}/${bin}`, `${base}-linux-${process.arch}-musl/${bin}`]
      : [`${base}-${process.platform}-${process.arch}/${bin}`]
  for (const cand of candidates) {
    try {
      let p = require.resolve(cand)
      if (p.includes(`app.asar${sep}`)) p = p.replace(`app.asar${sep}`, `app.asar.unpacked${sep}`)
      console.log(`[claude] CLI binary: ${p}`)
      claudeExecCache = p
      return p
    } catch {
      // not this candidate — try the next
    }
  }
  console.warn(`[claude] no native CLI binary found for ${process.platform}-${process.arch}`)
  claudeExecCache = null
  return undefined
}

/** Spread into every query()'s options so each turn spawns the unpacked binary. */
export function claudeExecOpt(): { pathToClaudeCodeExecutable?: string } {
  const p = claudeExecutable()
  return p ? { pathToClaudeCodeExecutable: p } : {}
}
