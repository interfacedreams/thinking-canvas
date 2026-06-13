import { BaseEdge, EdgeLabelRenderer, getBezierPath, type EdgeProps } from '@xyflow/react'
import { X } from 'lucide-react'
import { useCanvasStore } from '../store/canvas'

/**
 * Context connector: note/file → chat, bottom circle to top circle, arrowhead
 * on the chat end. While it exists, the source rides the chat's sends (notes
 * as system-prompt content; images and PDFs as image/document blocks injected
 * into the conversation once per session). The midpoint × disconnects it.
 */

// Stop the arrow just shy of the target circle so the head rests above the
// white ring instead of digging into it.
const TARGET_GAP = 3
export default function ContextEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  style,
  markerEnd
}: EdgeProps): React.JSX.Element {
  const removeContextEdge = useCanvasStore((s) => s.removeContextEdge)
  const [path, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY: targetY - TARGET_GAP,
    targetPosition
  })
  return (
    <>
      <BaseEdge id={id} path={path} style={style} markerEnd={markerEnd} />
      <EdgeLabelRenderer>
        <button
          type="button"
          onClick={() => removeContextEdge(id)}
          title="Disconnect"
          style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          className="nodrag nopan pointer-events-auto absolute flex h-5 w-5 cursor-pointer items-center justify-center rounded-full border border-black/10 bg-white text-neutral-400 shadow-sm transition-colors hover:bg-red-50 hover:text-red-600"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </EdgeLabelRenderer>
    </>
  )
}
