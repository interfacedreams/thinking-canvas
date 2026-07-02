import { useEffect, useImperativeHandle, useRef, type Ref } from 'react'
import { EditorContent, useEditor, type Editor } from '@tiptap/react'
import { Extension, InputRule, type JSONContent } from '@tiptap/core'
import { Selection } from '@tiptap/pm/state'
import StarterKit from '@tiptap/starter-kit'
import HardBreak from '@tiptap/extension-hard-break'
import { Markdown } from '@tiptap/markdown'
import { Placeholder } from '@tiptap/extensions'
import { BlockMath, InlineMath } from '@tiptap/extension-mathematics'
import 'katex/dist/katex.min.css'

// Serialize hard breaks as backslash breaks ("\<newline>", CommonMark's other
// hard-break syntax) instead of the default trailing double-space. That keeps
// the two syntaxes distinguishable in note files: "\<newline>" is deliberate
// in-app structure (Shift+Enter, pasted lines), while trailing double-spaces
// are how AI turns hard-wrap prose at ~80 cols — which setMarkdown demotes.
const BackslashHardBreak = HardBreak.extend({
  renderMarkdown: () => '\\\n'
})

// StarterKit's heading input rule (`^#{1,6}\s`) only fires at the true start of
// a textblock. Notes routinely hold several visual lines inside one paragraph,
// joined by hard breaks (pasted text, AI "\<newline>" breaks). Typing "# " at
// the start of such a line then sits there as literal text — the `#` isn't at
// the block start, so nothing converts. This rule covers exactly that gap: when
// "#{1,6} " is typed right after a hard break, split the block there and promote
// the trailing line to a heading. Hard breaks serialize to "\n" in the input-
// rule text (their toText spec), so the leading "\n" is what marks the seam.
const HeadingAfterBreak = Extension.create({
  name: 'headingAfterBreak',
  addInputRules() {
    return [
      new InputRule({
        find: /\n(#{1,6})\s$/,
        handler: ({ state, range, match }) => {
          const headingType = state.schema.nodes.heading
          if (!headingType) return null
          const hbPos = range.from
          // The match's leading "\n" must be a real hard break (not, say, an
          // inline-math leaf that also renders as a placeholder).
          if (state.doc.nodeAt(hbPos)?.type.name !== 'hardBreak') return null
          const level = match[1].length
          const hashStart = range.to - level
          const { tr } = state
          // Delete right-to-left so earlier positions stay valid: drop the
          // "#{level}" markers, then the hard break, then split the seam into a
          // fresh heading block carrying the rest of the line.
          tr.delete(hashStart, range.to)
          tr.delete(hbPos, hashStart)
          tr.split(hbPos, 1, [{ type: headingType, attrs: { level } }])
          tr.setSelection(Selection.near(tr.doc.resolve(hbPos + 1)))
          return null
        }
      })
    ]
  }
})

// marked (under @tiptap/markdown) keeps soft breaks as literal "\n" inside
// text tokens, and TipTap renders with white-space: pre-wrap — so AI-written
// markdown hard-wrapped at ~80 cols would show its wrap seams as real line
// breaks. Flatten them to spaces post-parse; deliberate structure is safe
// because hard breaks are separate hardBreak nodes and code blocks keep
// their newlines. parse() returns fresh JSON, so mutating is fine.
function reflowSoftBreaks(node: JSONContent): JSONContent {
  if (node.type === 'codeBlock') return node
  if (typeof node.text === 'string') node.text = node.text.replace(/\n/g, ' ')
  node.content?.forEach(reflowSoftBreaks)
  return node
}

// Trailing double-spaces are markdown hard breaks — but in files they come
// from AI turns hard-wrapping prose at ~80 cols, freezing the wrap seams at
// whatever width the model picked. Demote them to soft breaks pre-parse so
// reflowSoftBreaks flattens them. Deliberate in-app breaks are unaffected:
// BackslashHardBreak serializes those as "\<newline>". Fenced code keeps its
// bytes.
function demoteTrailingSpaceBreaks(markdown: string): string {
  let inFence = false
  return markdown
    .split('\n')
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) inFence = !inFence
      return inFence ? line : line.replace(/ {2,}$/, '')
    })
    .join('\n')
}

function setMarkdown(editor: Editor, markdown: string): void {
  const content = editor.markdown
    ? reflowSoftBreaks(editor.markdown.parse(demoteTrailingSpaceBreaks(markdown)))
    : markdown
  editor.commands.setContent(content, { emitUpdate: false })
}

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
// it on the way in and serializes back on every edit, so persistence and AI
// turns (which read/write the note file as markdown) never see ProseMirror
// documents.
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
        link: { openOnClick: false },
        hardBreak: false // replaced by BackslashHardBreak
      }),
      BackslashHardBreak,
      HeadingAfterBreak,
      // KaTeX rendering for `$…$` (inline) and `$$…$$` (block) math. Both
      // carry markdown tokenizers/serializers, so the `$`-delimited LaTeX the
      // AI writes parses into rendered nodes and round-trips back to the file.
      BlockMath.configure({ katexOptions: { throwOnError: false } }),
      InlineMath.configure({ katexOptions: { throwOnError: false } }),
      Markdown,
      Placeholder.configure({ placeholder: 'Write a note…' })
    ],
    // Initial content goes through setMarkdown (not the content option) so
    // soft breaks reflow with the note width. Deliberate line structure
    // still survives as backslash hard breaks ("\<newline>"), which pastes
    // (below) and our own serializer emit.
    onCreate: ({ editor }) => setMarkdown(editor, content),
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
        // Each pasted line stays a line: CommonMark would reflow single
        // newlines away, so make them explicit (backslash) hard breaks first.
        const markdown = text.replace(/([^\n])\n(?!\n)/g, '$1\\\n')
        selfRef.current?.commands.insertContent(markdown, { contentType: 'markdown' })
        return true
      }
    }
  })

  useEffect(() => {
    selfRef.current = editor
  }, [editor])

  useImperativeHandle(ref, () => ({ focus: () => editor?.commands.focus('end') }), [editor])

  // Push external content into the editor (AI streaming).
  // The user's own keystrokes echo back the exact markdown we just serialized,
  // so they compare equal and skip the reset — the cursor never jumps.
  useEffect(() => {
    if (!editor || content === editor.getMarkdown()) return
    setMarkdown(editor, content)
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
