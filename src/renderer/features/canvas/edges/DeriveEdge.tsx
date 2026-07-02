import { BaseEdge, EdgeLabelRenderer, getBezierPath, Position, type EdgeProps } from '@xyflow/react'
import { X } from 'lucide-react'
import { useCanvasStore } from '@renderer/store/canvas'

/**
 * Provenance connector: any node → the note derived from it. Runs from the
 * source's right edge to the note's left edge (the note is placed to the
 * right), arrowhead on the note end to mark which way it was generated. The
 * midpoint × severs the link only — the note keeps its content and its own
 * session, it just stops reading as "made from that".
 */
const TARGET_GAP = 3
export default function DeriveEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  style,
  markerEnd
}: EdgeProps): React.JSX.Element {
  const removeContextEdge = useCanvasStore((s) => s.removeContextEdge)
  const [path, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition: Position.Right,
    targetX: targetX - TARGET_GAP,
    targetY,
    targetPosition: Position.Left
  })
  return (
    <>
      <BaseEdge id={id} path={path} style={style} markerEnd={markerEnd} />
      <EdgeLabelRenderer>
        <button
          type="button"
          onClick={() => removeContextEdge(id)}
          title="Detach this note from its source"
          style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          className="nodrag nopan pointer-events-auto absolute flex h-5 w-5 cursor-pointer items-center justify-center rounded-full border border-black/10 bg-white text-neutral-400 shadow-sm transition-colors hover:bg-red-50 hover:text-red-600"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </EdgeLabelRenderer>
    </>
  )
}
