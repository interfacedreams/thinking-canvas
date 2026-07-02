import { FileText, ImageOff } from 'lucide-react'
import { useCanvasStore, isFile } from '@renderer/store/canvas'
import PdfViewer from '@renderer/features/nodes/file/PdfViewer'

/**
 * A file node's content — the inline PDF viewer or the image itself — driven
 * by the node id straight from the store, so the same component serves the
 * canvas card and the side panel (only one renders at a time: the card shows
 * a stub while the file is docked).
 */
export default function FileBody({
  id,
  focused
}: {
  id: string
  focused: boolean
}): React.JSX.Element | null {
  const node = useCanvasStore((s) => s.nodes.find((n) => n.id === id))
  if (!node || !isFile(node)) return null
  const data = node.data
  const isPdf = data.kind === 'pdf'

  if (isPdf && data.file) {
    // keyed on the path: a different file is a fresh viewer, never a reload
    return <PdfViewer key={data.file} file={data.file} focused={focused} />
  }
  if (isPdf) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-2 text-(--np-deep)">
        <FileText className="h-10 w-10 opacity-60" />
        <span className="max-w-full truncate px-3 text-[15px] opacity-70">PDF attaching…</span>
      </div>
    )
  }
  if (data.dataUrl) {
    return (
      <img
        src={data.dataUrl}
        alt={data.title}
        draggable={false}
        className="h-full w-full object-contain select-none"
      />
    )
  }
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-2 text-neutral-400">
      <ImageOff className="h-8 w-8" />
      <span className="max-w-full truncate px-3 text-[13px]">{data.file ?? 'Image missing'}</span>
    </div>
  )
}
