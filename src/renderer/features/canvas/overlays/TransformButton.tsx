import { useReactFlow, useStore, getNodesBounds, getViewportForBounds } from '@xyflow/react'
import { FunctionSquare } from 'lucide-react'
import { useCanvasStore } from '@renderer/store/canvas'
import { CHIP_BUTTON } from '@renderer/features/nodes/shared/nodeChrome'
import Tooltip from '@renderer/ui/Tooltip'

/**
 * The transform chip every node card carries: arms transform mode for this
 * node (TransformFrame then wraps it in a dashed temporary frame with a
 * one-shot composer) and centers the node so the input lands in view, ready to
 * type. Clicking again disarms. The ƒ icon frames it as a transform — feed this
 * node through an instruction and get a note back.
 */
export default function TransformButton({ id }: { id: string }): React.JSX.Element {
  const armed = useCanvasStore((s) => s.transforming === id)
  const setTransforming = useCanvasStore((s) => s.setTransforming)
  const { getNodes, setViewport } = useReactFlow()
  const width = useStore((s) => s.width)
  const height = useStore((s) => s.height)
  const minZoom = useStore((s) => s.minZoom)
  return (
    <Tooltip label="Transform into a note">
      <button
        type="button"
        onClick={() => {
          if (armed) {
            setTransforming(null)
            return
          }
          setTransforming(id)
          // Bring the node (and its composer strip) to center; the composer
          // focuses itself on mount, so the cursor is already waiting. We compute
          // the destination viewport in one shot — getViewportForBounds is the
          // same helper fitView uses to center a node — then bake the downward pan
          // straight into its y so the strip rising above the node's top clears
          // into view. Doing it as a single setViewport (instead of fitView then a
          // second pan) makes the move one fluid zoom rather than a two-step jerk.
          // A note carries the taller toggle+input strip; others just the input.
          const node = getNodes().find((n) => n.id === id)
          if (!node || !width || !height) return
          const vp = getViewportForBounds(getNodesBounds([node]), width, height, minZoom, 1, 0.2)
          const strip = node.type === 'note' ? 108 : 50
          setViewport({ x: vp.x, y: vp.y + (strip + 24) * vp.zoom, zoom: vp.zoom }, { duration: 300 })
        }}
        className={CHIP_BUTTON}
      >
        <FunctionSquare className="h-[23px] w-[23px]" />
      </button>
    </Tooltip>
  )
}
