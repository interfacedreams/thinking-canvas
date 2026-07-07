import { useRef, type Ref } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import 'katex/dist/katex.min.css'
import { History, RefreshCw } from 'lucide-react'
import { useCanvasStore, isNote, notePager } from '@renderer/store/canvas'
import { paletteFor } from '@renderer/lib/palette'
import { useForwardedWheel } from '@renderer/lib/useForwardedWheel'
import { MarkdownSourceContext, markdownComponents } from '@renderer/lib/markdownLink'
import NoteEditor, { type NoteEditorHandle } from '@renderer/features/nodes/note/NoteEditor'
import PermissionPrompt from '@renderer/features/settings/PermissionPrompt'

/**
 * A note's ruled-paper editor body, driven by the node id straight from the
 * store — the same component serves the canvas card and the side panel (only
 * one renders at a time: the card shows a stub while the note is docked).
 *
 * `focused` gates wheel routing on the canvas (an unfocused card pans the
 * board); the panel passes inPanel, which scrolls natively instead.
 */
export default function NoteBody({
  id,
  focused,
  inPanel = false,
  editorRef
}: {
  id: string
  focused: boolean
  inPanel?: boolean
  editorRef?: Ref<NoteEditorHandle>
}): React.JSX.Element | null {
  const node = useCanvasStore((s) => s.nodes.find((n) => n.id === id))
  const setNoteContent = useCanvasStore((s) => s.setNoteContent)
  const discardNode = useCanvasStore((s) => s.discardNode)
  const respondPermission = useCanvasStore((s) => s.respondPermission)
  const restoreVersion = useCanvasStore((s) => s.restoreVersion)
  const reloadExternalEdit = useCanvasStore((s) => s.reloadExternalEdit)
  const scrollRef = useRef<HTMLDivElement>(null)

  const data = node && isNote(node) ? node.data : undefined

  // Scrolling the note body requires focus (the node is selected by clicking
  // it); otherwise the wheel pans the canvas. The panel scrolls natively.
  useForwardedWheel(scrollRef, !inPanel && !!data, focused)

  if (!data) return null
  const streaming = data.status === 'streaming'
  // A note is discardable while it has no substance yet.
  const blank = !data.content && !data.title && !data.sessionId && data.versions.length === 0
  const palette = paletteFor(data.color)

  // When the pager is parked on a past snapshot, the body turns into a read-
  // only viewer for it (with a Restore action) instead of the live editor.
  const { position, total, viewingOld } = notePager(data)
  const viewed = viewingOld ? data.versions[data.viewVersion!] : undefined

  return (
    <div className="nodrag relative mx-1 my-1 flex min-h-0 flex-1 cursor-auto flex-col overflow-hidden">
      {/* An agent edited this note while the user had unsaved changes — its new
          content is parked here rather than clobbering the edits in progress. */}
      {data.externalEdit && (
        <div className="mt-1 mb-1 flex shrink-0 items-center gap-2 rounded-[10px] bg-(--np-bg) px-3 py-1.5 text-[12px] text-(--np-deep)">
          <RefreshCw className="h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate">An agent updated this note on disk.</span>
          <button
            type="button"
            onClick={() => reloadExternalEdit(id)}
            className="shrink-0 cursor-pointer rounded-md bg-(--np-accent) px-2 py-0.5 font-medium text-white transition-colors hover:opacity-85"
          >
            Reload
          </button>
        </div>
      )}
      {viewed && (
        <div className="mt-1 mb-1 flex shrink-0 items-center gap-2 rounded-[10px] bg-black/5 px-3 py-1.5 text-[12px] text-neutral-600">
          <History className="h-3.5 w-3.5 shrink-0 text-(--np-deep)" />
          <span className="min-w-0 flex-1 truncate">
            Version {position} of {total} · {viewed.author === 'ai' ? 'AI' : 'you'} · read-only
          </span>
          <button
            type="button"
            onClick={() => void restoreVersion(id, data.viewVersion!)}
            className="shrink-0 cursor-pointer rounded-md bg-(--np-accent) px-2 py-0.5 font-medium text-white transition-colors hover:opacity-85"
          >
            Restore
          </button>
        </div>
      )}
      <div
        ref={scrollRef}
        style={{
          // ruled notepad lines, aligned to the 26px text grid and tinted
          // to the palette; `local` makes them scroll with the content
          backgroundImage: `repeating-linear-gradient(to bottom, transparent 0, transparent 25px, ${palette.edge}59 25px, ${palette.edge}59 26px)`,
          backgroundAttachment: 'local',
          backgroundPosition: '0 8px'
        }}
        className="nowheel select-text transcript-scroll min-h-0 flex-1 overflow-x-hidden overflow-y-auto pb-1 text-[15px] leading-[26px] text-neutral-900"
      >
        {viewed ? (
          <div className="note-prose px-3 py-2 break-words opacity-80">
            {viewed.content ? (
              <MarkdownSourceContext.Provider value={id}>
                <Markdown
                  remarkPlugins={[
                    // singleTilde: false — ~approx~ must not render struck
                    // through (see ChatBody); only real ~~strikethrough~~.
                    [remarkGfm, { singleTilde: false }],
                    [remarkMath, { singleDollarTextMath: false }]
                  ]}
                  rehypePlugins={[rehypeKatex]}
                  components={markdownComponents}
                >
                  {viewed.content}
                </Markdown>
              </MarkdownSourceContext.Provider>
            ) : (
              <span className="text-neutral-400 italic">Empty version</span>
            )}
          </div>
        ) : (
          <>
            {/* While the AI is writing into an as-yet-empty note, stand in a pulse
                for the empty "Write a note…" placeholder — the note is busy, not
                idle. Once content starts landing, the editor takes over and a
                trailing pulse marks the still-streaming tail. */}
            {streaming && !data.content ? (
              <div className="animate-pulse px-3 py-2 text-[18px] leading-none tracking-widest text-neutral-400">
                ●●●
              </div>
            ) : (
              <NoteEditor
                ref={editorRef}
                content={data.content}
                readOnly={streaming}
                onChange={(md) => setNoteContent(id, md)}
                onEscape={() => {
                  if (blank) discardNode(id)
                }}
              />
            )}
          </>
        )}
      </div>

      {/* Transform/edit of an existing note: the body keeps showing the prior
          text (dimmed by the editor's read-only style) while the AI reworks it.
          Float the same triple-dots loader in the dead center as a "working"
          marker, rather than trailing it off the end of the content. */}
      {!viewed && streaming && data.content && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <span className="animate-pulse text-[18px] leading-none tracking-widest text-neutral-400">
            ●●●
          </span>
        </div>
      )}

      {/* A tool the editing turn fired needs the user's OK — without this the
          turn would stall invisibly (the note just never fills in). */}
      {data.pendingPermission && (
        <PermissionPrompt
          request={data.pendingPermission}
          onRespond={(allow) => respondPermission(id, data.pendingPermission!.requestId, allow)}
        />
      )}
    </div>
  )
}
