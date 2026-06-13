import { useReactFlow } from '@xyflow/react'
import { FunctionSquare } from 'lucide-react'
import { useCanvasStore } from '../store/canvas'
import { CHIP_BUTTON } from '../lib/nodeChrome'

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
  const { fitView, getViewport, setViewport } = useReactFlow()
  return (
    <button
      type="button"
      onClick={() => {
        if (armed) {
          setTransforming(null)
          return
        }
        setTransforming(id)
        // Bring the node (and its composer strip) to center; the composer
        // focuses itself on mount, so the cursor is already waiting. fitView
        // centers the node body, but the composer strip rises above the node's
        // top — so once centered, pan the view down to clear that strip into
        // view (a note carries the taller toggle+input strip, others just the
        // input bar).
        void fitView({ nodes: [{ id }], duration: 300, padding: 0.2, maxZoom: 1 }).then(() => {
          const vp = getViewport()
          const node = useCanvasStore.getState().nodes.find((n) => n.id === id)
          const strip = node?.type === 'note' ? 108 : 50
          setViewport({ x: vp.x, y: vp.y + (strip + 24) * vp.zoom, zoom: vp.zoom }, { duration: 200 })
        })
      }}
      title="Transform into a note"
      className={CHIP_BUTTON}
    >
      <FunctionSquare className="h-[23px] w-[23px]" />
    </button>
  )
}
