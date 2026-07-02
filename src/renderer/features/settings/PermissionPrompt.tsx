import { ShieldQuestion } from 'lucide-react'
import type { PermissionRequest } from '@shared/types'
import { useSettingsStore } from '@renderer/features/settings/settingsStore'

/** The most telling detail of a tool input — the query/command/url, not raw JSON. */
function permissionDetail(input: Record<string, unknown>): string {
  const detail = input.query ?? input.command ?? input.url ?? input.file_path ?? input.prompt
  const text = typeof detail === 'string' ? detail : JSON.stringify(input)
  return text.length > 200 ? `${text.slice(0, 200)}…` : text
}

/** Allow/Deny pill for a tool call held open by the SDK's canUseTool round-trip. */
export default function PermissionPrompt({
  request,
  onRespond
}: {
  request: PermissionRequest
  onRespond: (allow: boolean) => void
}): React.JSX.Element {
  const detail = permissionDetail(request.input)
  const openSettings = useSettingsStore((s) => s.setModalOpen)
  return (
    <div className="nodrag mx-1 mt-2 shrink-0 cursor-auto rounded-[10px] border border-(--np-edge) bg-white/85 px-3 py-2 text-[14px]">
      <div className="flex items-center gap-2 font-medium text-neutral-800">
        <ShieldQuestion className="h-4 w-4 shrink-0 text-(--np-deep)" />
        <span className="min-w-0 break-words">{request.title ?? `Allow ${request.toolName}?`}</span>
      </div>
      {detail && detail !== '{}' && (
        <div className="mt-1 line-clamp-3 font-mono text-[12px] break-all text-neutral-500">
          {detail}
        </div>
      )}
      <div className="mt-2 flex items-center gap-2">
        <button
          type="button"
          onClick={() => openSettings(true)}
          title="Auto-allow tools like this from the global settings"
          className="mr-auto cursor-pointer text-[12px] text-neutral-400 underline underline-offset-2 transition-colors hover:text-neutral-600"
        >
          global settings
        </button>
        <button
          type="button"
          onClick={() => onRespond(false)}
          className="cursor-pointer rounded-md px-3 py-1 text-neutral-500 transition-colors hover:bg-neutral-100"
        >
          Deny
        </button>
        <button
          type="button"
          onClick={() => onRespond(true)}
          className="cursor-pointer rounded-md bg-(--np-accent) px-3 py-1 font-medium text-white transition-colors hover:opacity-85"
        >
          Allow
        </button>
      </div>
    </div>
  )
}
