import { useRef, type Ref } from 'react'
import { useCanvasStore, isNote } from '../store/canvas'
import { paletteFor } from '../lib/palette'
import { useForwardedWheel } from '../lib/useForwardedWheel'
import NoteEditor, { type NoteEditorHandle } from './NoteEditor'
import PermissionPrompt from './PermissionPrompt'

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
  const scrollRef = useRef<HTMLDivElement>(null)

  const data = node && isNote(node) ? node.data : undefined

  // Scrolling the note body requires focus (the node is selected by clicking
  // it); otherwise the wheel pans the canvas. The panel scrolls natively.
  useForwardedWheel(scrollRef, !inPanel && !!data, focused)

  if (!data) return null
  const streaming = data.status === 'streaming'
  // A note is discardable while it has no substance yet.
  const blank = !data.content && !data.title && !data.sessionId
  const palette = paletteFor(data.color)

  return (
    <div className="nodrag mx-1 my-1 flex min-h-0 flex-1 cursor-auto flex-col overflow-hidden">
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
        {/* While the AI is writing into an as-yet-empty note, stand in a clear
            generating line for the empty "Write a note…" placeholder — the note
            is busy, not idle. Once content starts landing, the editor takes
            over and a trailing pulse marks the still-streaming tail. */}
        {streaming && !data.content ? (
          <div className="flex items-center gap-2 px-3 py-2 text-neutral-400">
            <span className="animate-pulse text-[18px] leading-none tracking-widest">●●●</span>
            <span className="text-[13px]">Writing the note…</span>
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
        {streaming && data.content && (
          <div className="animate-pulse px-3 py-1 tracking-widest text-neutral-400">●●●</div>
        )}
      </div>

      {/* A tool the editing turn fired needs the user's OK — without this the
          turn would stall invisibly (the note just never fills in). */}
      {data.pendingPermission && (
        <PermissionPrompt
          request={data.pendingPermission}
          onRespond={(allow) => respondPermission(id, data.pendingPermission!.requestId, allow)}
        />
      )}

      {/* The AI's brief commentary from its last turn — and, when a turn fails,
          the ⚠️ reason — so a failed transform says so instead of leaving an
          empty note behind. */}
      {!streaming && data.lastReply && (
        <div className="nodrag mt-1 shrink-0 rounded-[10px] bg-white/70 px-3 py-2 text-[13px] leading-snug whitespace-pre-wrap text-neutral-600">
          {data.lastReply}
        </div>
      )}
    </div>
  )
}
