import { BaseEdge, EdgeLabelRenderer, getBezierPath, type EdgeProps } from '@xyflow/react'
import { X } from 'lucide-react'
import { useCanvasStore } from '../store/canvas'

/**
 * Connection wire: an undirected, arrowless line between two cards' knobs.
 * While it exists, the connected resource rides the chat's sends (notes as
 * system-prompt content; pages from tabs; images and PDFs as blocks injected
 * once per session). The midpoint × disconnects it.
 */

// React Flow anchors an edge at a top-positioned handle's TOP edge, which
// leaves the line floating just shy of the knob's white ring. Extend both
// endpoints down to the knob centers — the knob draws above the edge layer,
// so the wire visually plugs straight into it.
const KNOB_PLUG = 16 // ≈ knob radius (31px knob + 2px ring)
export default function ContextEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  style,
  markerStart,
  markerEnd
}: EdgeProps): React.JSX.Element {
  const removeContextEdge = useCanvasStore((s) => s.removeContextEdge)
  const [path, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY: sourceY + KNOB_PLUG,
    sourcePosition,
    targetX,
    targetY: targetY + KNOB_PLUG,
    targetPosition
  })
  return (
    <>
      <BaseEdge id={id} path={path} style={style} markerStart={markerStart} markerEnd={markerEnd} />
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
