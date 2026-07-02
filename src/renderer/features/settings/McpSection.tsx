import { useEffect, useState } from 'react'
import { Plug } from 'lucide-react'
import { useSettingsStore } from '@renderer/features/settings/settingsStore'

/**
 * MCP connectors tab of the global settings modal. The user pastes a standard
 * Claude Desktop `mcpServers` JSON config; enabled servers are handed to every
 * agent turn (across all folders) and their tools auto-approve, since adding a
 * server is itself consent to use it. The raw JSON — credentials included — is
 * stored encrypted in the main process and round-trips here for editing.
 *
 * This is how you wire in your own web search (e.g. a SERP API MCP server)
 * instead of Claude's built-in WebSearch.
 */
const PLACEHOLDER = `{
  "mcpServers": {
    "serp": {
      "command": "npx",
      "args": ["-y", "serpapi-mcp-server"],
      "env": { "SERPAPI_API_KEY": "your-key" }
    }
  }
}`

const INDENT = '  ' // two spaces — matches the placeholder's nesting

// Replace the textarea's current selection with `text`, routed through
// execCommand so the browser's native undo stack and React's onChange (which
// listens for the resulting `input` event) both stay intact — manually
// reassigning .value would break undo and desync the controlled value.
function replaceSelection(ta: HTMLTextAreaElement, text: string): void {
  if (!document.execCommand('insertText', false, text)) {
    // Fallback for the rare engine without insertText support.
    const { selectionStart, selectionEnd, value } = ta
    ta.value = value.slice(0, selectionStart) + text + value.slice(selectionEnd)
    const caret = selectionStart + text.length
    ta.setSelectionRange(caret, caret)
    ta.dispatchEvent(new Event('input', { bubbles: true }))
  }
}

// Code-editor ergonomics for the JSON textarea: Tab / Shift+Tab indent and
// dedent (whole lines when a selection spans them), and Enter keeps the current
// indentation — opening a fresh line inside { } or [ ] when the caret sits
// between a matching pair.
function handleJsonKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>): void {
  const ta = e.currentTarget
  const { selectionStart: start, selectionEnd: end, value } = ta

  if (e.key === 'Tab') {
    e.preventDefault()
    const multiLine = start !== end && value.slice(start, end).includes('\n')

    if (!e.shiftKey && !multiLine) {
      replaceSelection(ta, INDENT)
      return
    }

    // Operate on every line touched by the selection.
    const blockStart = value.lastIndexOf('\n', start - 1) + 1
    const lines = value.slice(blockStart, end).split('\n')
    let firstDelta = 0
    let totalDelta = 0
    const rebuilt = lines
      .map((line, i) => {
        if (e.shiftKey) {
          const removed = (line.match(/^ {1,2}|^\t/)?.[0] ?? '').length
          if (i === 0) firstDelta = -removed
          totalDelta -= removed
          return line.slice(removed)
        }
        if (i === 0) firstDelta = INDENT.length
        totalDelta += INDENT.length
        return INDENT + line
      })
      .join('\n')

    ta.setSelectionRange(blockStart, end)
    replaceSelection(ta, rebuilt)
    ta.setSelectionRange(Math.max(blockStart, start + firstDelta), end + totalDelta)
    return
  }

  if (e.key === 'Enter') {
    e.preventDefault()
    const lineStart = value.lastIndexOf('\n', start - 1) + 1
    const indent = value.slice(lineStart, start).match(/^[ \t]*/)?.[0] ?? ''
    const prev = value[start - 1]
    const next = value[start]
    const opensBlock = prev === '{' || prev === '['

    if (start === end && opensBlock && (next === '}' || next === ']')) {
      // Caret between a matching pair → expand to three lines, caret indented.
      replaceSelection(ta, `\n${indent}${INDENT}\n${indent}`)
      const caret = start + 1 + indent.length + INDENT.length
      ta.setSelectionRange(caret, caret)
      return
    }
    replaceSelection(ta, `\n${indent}${opensBlock ? INDENT : ''}`)
  }
}

// Visual treatment per connection state. `pending` doubles as the in-flight
// "connecting" look while a probe runs.
const STATUS_META: Record<string, { dot: string; label: string }> = {
  connected: { dot: 'bg-[#3FA34D] shadow-[0_0_0_2px_rgba(63,163,77,0.2)]', label: 'Connected' },
  pending: { dot: 'bg-amber-400 shadow-[0_0_0_2px_rgba(251,191,36,0.2)]', label: 'Connecting…' },
  'needs-auth': { dot: 'bg-orange-400', label: 'Needs auth' },
  failed: { dot: 'bg-red-500', label: 'Failed' },
  error: { dot: 'bg-red-500', label: 'Not started' },
  disabled: { dot: 'bg-neutral-300', label: 'Disabled' }
}

export default function McpSection(): React.JSX.Element {
  const mcp = useSettingsStore((s) => s.mcp)
  const mcpLoadFailed = useSettingsStore((s) => s.mcpLoadFailed)
  const loadMcp = useSettingsStore((s) => s.loadMcp)
  const updateMcp = useSettingsStore((s) => s.updateMcp)
  const mcpStatus = useSettingsStore((s) => s.mcpStatus)
  const mcpProbing = useSettingsStore((s) => s.mcpProbing)
  const probeMcp = useSettingsStore((s) => s.probeMcp)

  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  // Cleared on edit, set after a save round-trip so the user sees it landed.
  const [saved, setSaved] = useState(false)

  // Load once, and seed the textarea from the stored config when it arrives.
  useEffect(() => {
    if (!mcp) void loadMcp()
  }, [mcp, loadMcp])
  useEffect(() => {
    if (mcp) setDraft(mcp.json)
  }, [mcp])

  const dirty = mcp != null && draft !== mcp.json
  // The config is only editable while connectors are on — a locked, dimmed box
  // makes the disabled state unmistakable. Flip the toggle on to edit.
  const editable = mcp?.enabled ?? false
  // Probing reads the *saved* config, so block it on unsaved edits, an empty or
  // unparseable config, a disabled switch, or a probe already running.
  const canTest =
    !!mcp?.enabled && !mcp.error && mcp.serverNames.length > 0 && !dirty && !busy && !mcpProbing

  const save = async (): Promise<void> => {
    setBusy(true)
    try {
      await updateMcp({ json: draft })
      setSaved(true)
    } finally {
      setBusy(false)
    }
  }

  const toggle = async (enabled: boolean): Promise<void> => {
    setBusy(true)
    try {
      await updateMcp({ enabled })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col">
      <h3 className="mb-2 flex items-center gap-2 text-[14px] font-semibold text-black">
        <Plug className="h-4 w-4" />
        MCP connectors
      </h3>

      {/* The only way this fires is a stale preload missing window.api.mcp,
          which can't happen in a shipped build (preload + renderer ship and
          load together) — it's a dev-only artifact of hot-swapping the bridge.
          Gated to dev so production never shows a misleading restart prompt. */}
      {mcpLoadFailed && import.meta.env.DEV && (
        <p className="mb-3 rounded-[7px] border border-amber-300 bg-amber-50 px-3 py-2 text-[12px] text-amber-800">
          Fully restart the dev app to finish setting this up — the connector settings load on
          startup.
        </p>
      )}

      <div className="mb-3 flex items-center gap-3 rounded-[7px] border border-neutral-200 bg-neutral-50 px-3 py-2">
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium text-neutral-800">Enable connectors</div>
          <div className="text-[12px] text-neutral-500">
            Off means no MCP servers are passed to the agent.
          </div>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={mcp?.enabled ?? false}
          disabled={busy || mcp == null}
          onClick={() => void toggle(!(mcp?.enabled ?? false))}
          className={`relative h-5 w-9 shrink-0 cursor-pointer rounded-full transition-colors disabled:opacity-50 ${
            mcp?.enabled ? 'bg-black' : 'bg-neutral-300'
          }`}
        >
          <div
            className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform ${
              mcp?.enabled ? 'translate-x-[18px]' : 'translate-x-0.5'
            }`}
          />
        </button>
      </div>

      <textarea
        value={draft}
        spellCheck={false}
        placeholder={PLACEHOLDER}
        readOnly={!editable}
        onKeyDown={editable ? handleJsonKeyDown : undefined}
        onChange={(e) => {
          setDraft(e.target.value)
          setSaved(false)
        }}
        className={`mb-2 h-52 w-full resize-none rounded-[7px] border px-2.5 py-2 font-mono text-[12px] leading-relaxed outline-none ${
          editable
            ? 'border-neutral-300 bg-white text-neutral-800 focus:border-black'
            : 'cursor-not-allowed border-neutral-200 bg-neutral-50 text-neutral-400'
        }`}
      />

      {mcp?.error ? (
        <p className="mb-2 text-[12px] text-red-600">{mcp.error}</p>
      ) : mcp && mcp.serverNames.length > 0 ? (
        <div className="mb-2 flex flex-col gap-1">
          {mcp.serverNames.map((name) => {
            // While a probe runs, every server reads as "connecting"; otherwise
            // show its last probed status, or a neutral "unchecked" dot.
            const result = mcpProbing
              ? { status: 'pending' as const }
              : mcpStatus?.servers.find((s) => s.name === name)
            const meta = result ? STATUS_META[result.status] : null
            const detail =
              result && 'error' in result && result.error
                ? result.error
                : result && 'toolCount' in result && result.toolCount != null
                  ? `${result.toolCount} tool${result.toolCount === 1 ? '' : 's'}`
                  : null
            return (
              <div key={name} className="flex items-center gap-2 text-[12px]">
                <span
                  className={`h-2 w-2 shrink-0 rounded-full ${meta ? meta.dot : 'bg-neutral-300'}`}
                />
                <span className="font-mono text-neutral-800">{name}</span>
                <span className="text-neutral-500">
                  {meta ? meta.label : mcp.enabled ? 'Not checked' : 'Disabled'}
                  {detail && <span className="text-neutral-400"> · {detail}</span>}
                </span>
              </div>
            )
          })}
          {mcpStatus?.error && !mcpProbing && (
            <p className="text-[12px] text-red-600">{mcpStatus.error}</p>
          )}
        </div>
      ) : null}

      <div className="flex items-center justify-end gap-2">
        {saved && !dirty && <span className="text-[12px] text-neutral-400">Saved</span>}
        <button
          type="button"
          disabled={!canTest}
          onClick={() => void probeMcp()}
          title={dirty ? 'Save the config first' : 'Connect to the servers and report status'}
          className="cursor-pointer rounded-[6px] border border-neutral-300 bg-neutral-100 px-3 py-1.5 text-[12px] font-medium text-neutral-700 transition-colors hover:bg-neutral-200 disabled:cursor-default disabled:opacity-50 disabled:hover:bg-neutral-100"
        >
          {mcpProbing ? 'Testing…' : 'Test connection'}
        </button>
        <button
          type="button"
          disabled={busy || !dirty}
          onClick={() => void save()}
          className="cursor-pointer rounded-[6px] border border-black bg-black px-3 py-1.5 text-[12px] font-medium text-white shadow-md transition-colors hover:bg-neutral-800 disabled:cursor-default disabled:opacity-50 disabled:hover:bg-black"
        >
          Save config
        </button>
      </div>
    </div>
  )
}
