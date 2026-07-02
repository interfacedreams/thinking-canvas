import { app, ipcMain, safeStorage } from 'electron'
import { promises as fs, readFileSync } from 'fs'
import { join } from 'path'
import type { AuthStatus } from '../shared/types'

// Minimal .env loader (ANTHROPIC_API_KEY etc.) — real values never leave the main
// process. Read from the app's own launch dir, independent of the chosen folder.
export function loadDotEnv(): void {
  try {
    for (const line of readFileSync(join(process.cwd(), '.env'), 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/)
      if (m && process.env[m[1]] === undefined) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
      }
    }
  } catch {
    // no .env — fine if the key is already in the environment
  }
}

// Claude auth: credentials live in userData/auth.json (each secret encrypted
// when the OS keychain is available). Two kinds, in precedence order:
//   1. a subscription OAuth token from `claude setup-token`
//   2. an Anthropic API key set in Settings
// The agent SDK subprocess inherits our env, so choosing the subscription means
// exporting CLAUDE_CODE_OAUTH_TOKEN and removing ANTHROPIC_API_KEY — inside the
// CLI an API key would otherwise take precedence over the subscription token.
// The .env/environment ANTHROPIC_API_KEY is still honored as a last-resort
// fallback, but a key set in Settings is the preferred way to provide one.

export const authFile = (): string => join(app.getPath('userData'), 'auth.json')

export let envApiKey: string | undefined // the .env/environment key, kept as a fallback
export let oauthToken: string | null = null
export let userApiKey: string | null = null // API key set in Settings; beats .env, loses to subscription
// A secret was present in auth.json but could not be decrypted (keychain identity
// changed between builds, etc.). We surface this instead of silently downgrading
// to the .env key — otherwise a present-but-unreadable token looks like "no token".
export let tokenUnreadable = false
export let apiKeyUnreadable = false

// A secret persists as { encrypted: base64 } when the keychain is available,
// else { plain: string }. Older files stored the subscription token at the top
// level as { encrypted } or { token }, so decodeSecret accepts those too.
//
// Returns { value } on success (value null = field genuinely absent), or
// { value: null, unreadable: true } when an encrypted secret is present but
// cannot be decrypted — that is a real credential we must not silently treat as
// "no credential". safeStorage.decryptString throws when the keychain identity
// differs from the one that encrypted the value (e.g. dev vs packaged build, or
// a changed app name), so we catch it here rather than letting it bubble up and
// collapse into the generic "no auth" path.
export function decodeSecret(value: unknown): { value: string | null; unreadable?: boolean } {
  if (typeof value === 'string') return { value: value || null }
  if (value && typeof value === 'object') {
    const enc = (value as { encrypted?: unknown }).encrypted
    if (typeof enc === 'string') {
      if (!safeStorage.isEncryptionAvailable()) return { value: null, unreadable: true }
      try {
        return { value: safeStorage.decryptString(Buffer.from(enc, 'base64')) || null }
      } catch (err) {
        console.warn('[auth] stored secret present but could not be decrypted:', err)
        return { value: null, unreadable: true }
      }
    }
    const plain =
      (value as { plain?: unknown; token?: unknown }).plain ?? (value as { token?: unknown }).token
    if (typeof plain === 'string' && plain) return { value: plain }
  }
  return { value: null }
}

export function encodeSecret(secret: string): { encrypted: string } | { plain: string } {
  return safeStorage.isEncryptionAvailable()
    ? { encrypted: safeStorage.encryptString(secret).toString('base64') }
    : { plain: secret }
}

export async function readStoredAuth(): Promise<{
  token: string | null
  apiKey: string | null
  tokenUnreadable: boolean
  apiKeyUnreadable: boolean
}> {
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(await fs.readFile(authFile(), 'utf8'))
  } catch {
    // file missing or not valid JSON — genuinely no credentials
    return { token: null, apiKey: null, tokenUnreadable: false, apiKeyUnreadable: false }
  }
  // Back-compat: a top-level { encrypted } / { token } is the old subscription token.
  const tokenField = raw.token !== undefined ? raw.token : raw
  const token = decodeSecret(tokenField)
  const apiKey = decodeSecret(raw.apiKey)
  return {
    token: token.value,
    apiKey: apiKey.value,
    tokenUnreadable: token.unreadable === true,
    apiKeyUnreadable: apiKey.unreadable === true
  }
}

export async function writeStoredAuth(): Promise<void> {
  const body: Record<string, unknown> = {}
  if (oauthToken) body.token = encodeSecret(oauthToken)
  if (userApiKey) body.apiKey = encodeSecret(userApiKey)
  if (Object.keys(body).length === 0) {
    await fs.rm(authFile(), { force: true })
    return
  }
  await fs.writeFile(authFile(), JSON.stringify(body), { mode: 0o600 })
}

export function applyAuthEnv(): void {
  if (oauthToken) {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = oauthToken
    delete process.env.ANTHROPIC_API_KEY
    return
  }
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN
  // A stored credential exists but couldn't be decrypted. Do NOT quietly fall
  // back to the .env key and bill it — that masks the real, intended credential.
  // Leave the env clean so the SDK fails loudly and the UI prompts a re-entry.
  if (tokenUnreadable || apiKeyUnreadable) {
    delete process.env.ANTHROPIC_API_KEY
    return
  }
  const key = userApiKey ?? envApiKey
  if (key) process.env.ANTHROPIC_API_KEY = key
  else delete process.env.ANTHROPIC_API_KEY
}

export function authStatus(): AuthStatus {
  // When a stored credential is present but undecryptable we don't fall back to
  // the .env key (see applyAuthEnv), so don't advertise it as an active source.
  const blocked = tokenUnreadable || apiKeyUnreadable
  const apiKeySource = userApiKey ? 'settings' : !blocked && envApiKey ? 'env' : null
  return {
    method: oauthToken ? 'subscription' : apiKeySource ? 'apiKey' : 'none',
    tokenSuffix: oauthToken ? oauthToken.slice(-4) : null,
    apiKeySuffix: userApiKey ? userApiKey.slice(-4) : null,
    apiKeySource,
    hasApiKey: apiKeySource !== null,
    tokenUnreadable,
    apiKeyUnreadable
  }
}

export function registerAuthIpc(): void {
  ipcMain.handle('auth:status', (): AuthStatus => authStatus())

  ipcMain.handle('auth:setToken', async (_event, token: string): Promise<AuthStatus> => {
    const trimmed = String(token).trim()
    // setup-token output starts with sk-ant-oat…; accept any sk-ant- prefix
    // so a future prefix change doesn't lock users out.
    if (!trimmed.startsWith('sk-ant-')) {
      throw new Error('That does not look like a Claude token (expected sk-ant-…)')
    }
    oauthToken = trimmed
    tokenUnreadable = false // a freshly re-entered token replaces any unreadable one
    await writeStoredAuth()
    applyAuthEnv()
    return authStatus()
  })

  ipcMain.handle('auth:clearToken', async (): Promise<AuthStatus> => {
    oauthToken = null
    tokenUnreadable = false
    await writeStoredAuth()
    applyAuthEnv()
    return authStatus()
  })

  ipcMain.handle('auth:setApiKey', async (_event, key: string): Promise<AuthStatus> => {
    const trimmed = String(key).trim()
    if (!trimmed.startsWith('sk-ant-')) {
      throw new Error('That does not look like an Anthropic API key (expected sk-ant-…)')
    }
    userApiKey = trimmed
    apiKeyUnreadable = false
    await writeStoredAuth()
    applyAuthEnv()
    return authStatus()
  })

  ipcMain.handle('auth:clearApiKey', async (): Promise<AuthStatus> => {
    userApiKey = null
    apiKeyUnreadable = false
    await writeStoredAuth()
    applyAuthEnv()
    return authStatus()
  })
}
/** Boot-time auth: .env fallback key, stored credentials, env exports for the SDK. */
export async function initAuth(): Promise<void> {
  loadDotEnv()
  envApiKey = process.env.ANTHROPIC_API_KEY
  const stored = await readStoredAuth()
  oauthToken = stored.token
  userApiKey = stored.apiKey
  tokenUnreadable = stored.tokenUnreadable
  apiKeyUnreadable = stored.apiKeyUnreadable
  applyAuthEnv()
}
