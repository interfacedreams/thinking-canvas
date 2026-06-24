import { useEffect, useState } from 'react'
import { KeyRound, KeySquare } from 'lucide-react'
import type { AuthStatus } from '../../../shared/types'

/**
 * Credentials section of the global settings modal. Two stacked blocks sharing
 * one auth status:
 *   1. a Claude subscription OAuth token (`claude setup-token`) — billed to the
 *      user's Claude plan;
 *   2. an Anthropic API key — used when no subscription token is set.
 * Both are stored in the main process (encrypted when possible) and take effect
 * immediately, since each turn spawns a fresh SDK subprocess. The subscription
 * token wins over the API key, and a key set here wins over ANTHROPIC_API_KEY
 * from .env. Lives inside SettingsButton's modal.
 */
export default function AuthSection(): React.JSX.Element {
  const [status, setStatus] = useState<AuthStatus | null>(null)

  useEffect(() => {
    void window.api.auth.status().then(setStatus)
  }, [])

  return (
    <div className="flex flex-col">
      <SubscriptionBlock status={status} onChange={setStatus} />
      <div className="my-4 border-t border-neutral-200" />
      <ApiKeyBlock status={status} onChange={setStatus} />
    </div>
  )
}

function SubscriptionBlock({
  status,
  onChange
}: {
  status: AuthStatus | null
  onChange: (s: AuthStatus) => void
}): React.JSX.Element {
  const [draft, setDraft] = useState('')
  const [editing, setEditing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const save = async (): Promise<void> => {
    const token = draft.trim()
    if (!token.startsWith('sk-ant-')) {
      setError('That doesn’t look like a Claude token — expected it to start with sk-ant-')
      return
    }
    setBusy(true)
    setError(null)
    try {
      onChange(await window.api.auth.setToken(token))
      setDraft('')
      setEditing(false)
    } catch {
      setError('Couldn’t save the token. Check it and try again.')
    } finally {
      setBusy(false)
    }
  }

  const remove = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      onChange(await window.api.auth.clearToken())
    } finally {
      setBusy(false)
    }
  }

  const usingSub = status?.method === 'subscription'

  return (
    <div className="flex flex-col">
      <h3 className="mb-2 flex items-center gap-2 text-[14px] font-semibold text-black">
        <KeyRound className="h-4 w-4" />
        Claude subscription
      </h3>

      <p className="mb-2 text-[12px] text-neutral-600">
        Run <code className="rounded bg-neutral-100 px-1 font-mono">claude setup-token</code> in a
        terminal and paste the token here. Takes precedence over the API key.
      </p>

      {status?.tokenUnreadable && (
        <p className="mb-2 text-[12px] text-amber-700">
          A saved subscription token exists but couldn’t be decrypted (the app’s keychain identity
          changed). It’s not being used — paste it again to restore it.
        </p>
      )}

      {usingSub && !editing ? (
        <button
          type="button"
          onClick={() => setEditing(true)}
          title="Click to replace the token"
          className="mb-2 flex h-[31px] w-full cursor-text items-center rounded-[7px] border border-neutral-300 bg-white px-2.5 text-[8px] tracking-[0.25em] text-neutral-800"
        >
          {'•'.repeat(24)}
        </button>
      ) : (
        <input
          // A real type=password field puts macOS into Secure Input mode, which
          // blocks clipboard managers (Maccy etc.) from pasting — so we mask via
          // CSS on a normal text field instead. Same visual dots, paste works.
          type="text"
          value={draft}
          autoFocus={editing}
          autoComplete="off"
          onChange={(e) => {
            setDraft(e.target.value)
            setError(null)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void save()
          }}
          placeholder="sk-ant-oat01-…"
          spellCheck={false}
          className="mb-2 w-full rounded-[7px] border border-neutral-300 bg-white px-2.5 py-1.5 font-mono text-[12px] outline-none [-webkit-text-security:disc] focus:border-black"
        />
      )}
      {error && <p className="mb-2 text-[12px] text-red-600">{error}</p>}

      <div className="flex items-center justify-end gap-2">
        {usingSub && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void remove()}
            title={
              status?.hasApiKey
                ? 'Fall back to the API key'
                : 'Remove the token (no API key fallback found)'
            }
            className="cursor-pointer rounded-[6px] border border-neutral-300 bg-neutral-100 px-3 py-1.5 text-[12px] font-medium text-neutral-600 transition-colors hover:bg-neutral-200 disabled:opacity-50"
          >
            Remove token
          </button>
        )}
        <button
          type="button"
          disabled={busy || draft.trim() === ''}
          onClick={() => void save()}
          className="cursor-pointer rounded-[6px] border border-black bg-black px-3 py-1.5 text-[12px] font-medium text-white shadow-md transition-colors hover:bg-neutral-800 disabled:cursor-default disabled:hover:bg-black"
        >
          Save token
        </button>
      </div>
    </div>
  )
}

function ApiKeyBlock({
  status,
  onChange
}: {
  status: AuthStatus | null
  onChange: (s: AuthStatus) => void
}): React.JSX.Element {
  const [draft, setDraft] = useState('')
  const [editing, setEditing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const save = async (): Promise<void> => {
    const key = draft.trim()
    if (!key.startsWith('sk-ant-')) {
      setError('That doesn’t look like an Anthropic API key — expected it to start with sk-ant-')
      return
    }
    setBusy(true)
    setError(null)
    try {
      onChange(await window.api.auth.setApiKey(key))
      setDraft('')
      setEditing(false)
    } catch {
      setError('Couldn’t save the key. Check it and try again.')
    } finally {
      setBusy(false)
    }
  }

  const remove = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      onChange(await window.api.auth.clearApiKey())
    } finally {
      setBusy(false)
    }
  }

  const hasStoredKey = status?.apiKeySuffix != null
  const usingSub = status?.method === 'subscription'

  return (
    <div className="flex flex-col">
      <h3 className="mb-2 flex items-center gap-2 text-[14px] font-semibold text-black">
        <KeySquare className="h-4 w-4" />
        Anthropic API key
        {hasStoredKey && (
          <span
            title="Key stored"
            className="ml-0.5 h-2 w-2 rounded-full bg-[#3FA34D] shadow-[0_0_0_2px_rgba(63,163,77,0.2)]"
          />
        )}
      </h3>

      {(hasStoredKey || status?.apiKeySource === 'env') && (
        <p className="mb-2 text-[12px] text-neutral-600">
          {hasStoredKey
            ? usingSub
              ? 'Used if you remove the subscription token.'
              : 'Billing chats now.'
            : 'Using ANTHROPIC_API_KEY from .env.'}
        </p>
      )}

      {hasStoredKey && !editing ? (
        <button
          type="button"
          onClick={() => setEditing(true)}
          title="Click to replace the key"
          className="mb-2 flex h-[31px] w-full cursor-text items-center rounded-[7px] border border-neutral-300 bg-white px-2.5 text-[8px] tracking-[0.25em] text-neutral-800"
        >
          {'•'.repeat(24)}
        </button>
      ) : (
        <input
          // See SubscriptionBlock: masked text field, not type=password, so
          // macOS Secure Input doesn't block clipboard-manager pastes.
          type="text"
          value={draft}
          autoFocus={editing}
          autoComplete="off"
          onChange={(e) => {
            setDraft(e.target.value)
            setError(null)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void save()
          }}
          placeholder="sk-ant-api03-…"
          spellCheck={false}
          className="mb-2 w-full rounded-[7px] border border-neutral-300 bg-white px-2.5 py-1.5 font-mono text-[12px] outline-none [-webkit-text-security:disc] focus:border-black"
        />
      )}
      {error && <p className="mb-2 text-[12px] text-red-600">{error}</p>}

      <div className="flex items-center justify-end gap-2">
        {hasStoredKey && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void remove()}
            className="cursor-pointer rounded-[6px] border border-neutral-300 bg-neutral-100 px-3 py-1.5 text-[12px] font-medium text-neutral-600 transition-colors hover:bg-neutral-200 disabled:opacity-50"
          >
            Remove key
          </button>
        )}
        <button
          type="button"
          disabled={busy || draft.trim() === ''}
          onClick={() => void save()}
          className="cursor-pointer rounded-[6px] border border-black bg-black px-3 py-1.5 text-[12px] font-medium text-white shadow-md transition-colors hover:bg-neutral-800 disabled:cursor-default disabled:hover:bg-black"
        >
          Save key
        </button>
      </div>
    </div>
  )
}
