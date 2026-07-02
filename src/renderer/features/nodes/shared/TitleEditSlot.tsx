import { Pencil, TriangleAlert } from 'lucide-react'
import { CHIP_BUTTON } from '@renderer/features/nodes/shared/nodeChrome'
import { DUPLICATE_TITLE_HINT } from '@renderer/features/nodes/shared/titleGuard'
import Tooltip from '@renderer/ui/Tooltip'

// The header slot that lives just left of the transform/delete buttons. It
// reuses one footprint across three states so nothing reflows when rename mode
// opens: a pencil at rest, an invisible spacer while a valid title is being
// edited, and a warning the moment that title collides with another node's.
export default function TitleEditSlot({
  editing,
  duplicate,
  onEdit,
  renameHint
}: {
  editing: boolean
  duplicate: boolean
  onEdit: () => void
  renameHint: string
}): React.JSX.Element {
  if (editing) {
    return (
      <div
        title={duplicate ? DUPLICATE_TITLE_HINT : undefined}
        className="flex h-9 w-9 shrink-0 items-center justify-center"
      >
        {duplicate && (
          <TriangleAlert
            className="h-[25px] w-[25px] text-amber-500"
            aria-label={DUPLICATE_TITLE_HINT}
          />
        )}
      </div>
    )
  }
  return (
    <Tooltip label={renameHint}>
      <button type="button" onClick={onEdit} className={CHIP_BUTTON}>
        <Pencil className="h-[25px] w-[25px]" />
      </button>
    </Tooltip>
  )
}
