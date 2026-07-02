import { BaseEdge, getBezierPath, Position, useInternalNode, type EdgeProps } from '@xyflow/react'
import { useCanvasStore } from '@renderer/store/canvas'

/**
 * Fork connector that attaches to the anchor message inside the source chat,
 * not the chat box as a whole. The message's y-offset is measured from the DOM
 * by ChatNodeView (clamped to the node when scrolled away); until it's known —
 * or while the source is minimized — fall back to the node-level handle.
 */
export default function ForkEdge({
  id,
  source,
  sourceX,
  sourceY,
  targetX,
  targetY,
  data,
  style
}: EdgeProps): React.JSX.Element {
  const messageId = (data as { sourceMessageId?: string } | undefined)?.sourceMessageId
  const offset = useCanvasStore((s) =>
    messageId ? s.anchorOffsets[source]?.[messageId] : undefined
  )
  const sourceNode = useInternalNode(source)

  const anchoredY =
    offset != null && sourceNode ? sourceNode.internals.positionAbsolute.y + offset : sourceY

  const [path] = getBezierPath({
    sourceX,
    sourceY: anchoredY,
    sourcePosition: Position.Right,
    targetX,
    targetY,
    targetPosition: Position.Left
  })
  return <BaseEdge id={id} path={path} style={style} />
}
