import { useEffect, useImperativeHandle, useRef, type Ref } from 'react'
import { EditorContent, useEditor, type Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { Markdown } from '@tiptap/markdown'
import { Placeholder } from '@tiptap/extensions'

export interface NoteEditorHandle {
  focus: () => void
}

interface NoteEditorProps {
  content: string
  readOnly: boolean
  onChange: (markdown: string) => void
  onEscape: () => void
  ref?: Ref<NoteEditorHandle>
}

// WYSIWYG body for notes. The store keeps plain markdown — the editor parses
// it on the way in and serializes back on every edit, so persistence, version
// snapshots, and AI turns (which read/write the note file as markdown) never
// see ProseMirror documents.
function NoteEditor({
  content,
  readOnly,
  onChange,
  onEscape,
  ref
}: NoteEditorProps): React.JSX.Element {
  // Latest-callback refs: useEditor captures its options once at creation.
  const onChangeRef = useRef(onChange)
  const selfRef = useRef<Editor | null>(null)
  useEffect(() => {
    onChangeRef.current = onChange
  }, [onChange])

  const editor = useEditor({
    extensions: [
      // Full StarterKit (not just the marks we style): the AI writes lists,
      // code blocks, etc. into notes, and any node missing from the schema
      // would be silently mangled on the parse → serialize round trip.
      StarterKit.configure({
        // plain click places the cursor; ⌘-click (below) opens the link
        link: { openOnClick: false }
      }),
      // breaks:true keeps single newlines as hard breaks — pasted lines and
      // notes written before the WYSIWYG editor would otherwise collapse
      // into one paragraph under CommonMark soft-break rules
      Markdown.configure({ markedOptions: { breaks: true } }),
      Placeholder.configure({ placeholder: 'Write a note…' })
    ],
    contentType: 'markdown',
    content,
    editable: !readOnly,
    onUpdate: ({ editor }) => onChangeRef.current(editor.getMarkdown()),
    editorProps: {
      attributes: {
        // min-height ≈ the 6 rows the old textarea reserved (6 × 26px grid + padding)
        class: 'note-prose block min-h-[172px] w-full cursor-text px-3 py-2 outline-none'
      },
      // Parse plain-text pastes as markdown. Marks (bold/italic) have paste
      // rules, but block syntax doesn't — without this a pasted "## title"
      // stays literal hashes.
      handlePaste: (_view, event) => {
        const clip = event.clipboardData
        const text = clip?.getData('text/plain')
        if (!text || clip?.getData('text/html')) return false
        selfRef.current?.commands.insertContent(text, { contentType: 'markdown' })
        return true
      }
    }
  })

  useEffect(() => {
    selfRef.current = editor
  }, [editor])

  useImperativeHandle(ref, () => ({ focus: () => editor?.commands.focus('end') }), [editor])

  // Push external content into the editor (AI streaming, restore, version nav).
  // The user's own keystrokes echo back the exact markdown we just serialized,
  // so they compare equal and skip the reset — the cursor never jumps.
  useEffect(() => {
    if (!editor || content === editor.getMarkdown()) return
    editor.commands.setContent(content, { contentType: 'markdown', emitUpdate: false })
  }, [editor, content])

  useEffect(() => {
    editor?.setEditable(!readOnly)
  }, [editor, readOnly])

  return (
    <EditorContent
      editor={editor}
      className={readOnly ? 'text-neutral-500' : ''}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          onEscape()
          // discard (above) unmounts the node; otherwise release typing focus
          // so canvas shortcuts (C/N) work again
          editor?.commands.blur()
        }
      }}
      onClick={(e) => {
        const a = (e.target as HTMLElement).closest('a')
        // window.open is intercepted by the main process and routed to the OS browser
        if (a?.href && (e.metaKey || e.ctrlKey)) window.open(a.href)
      }}
    />
  )
}

export default NoteEditor
