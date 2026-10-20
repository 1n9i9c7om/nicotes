import { forwardRef, useImperativeHandle, useMemo } from 'react';
import { Selection } from '@tiptap/pm/state';
import { EditorContent, useEditor } from '@tiptap/react';
import { editorExtensions } from './extensions';
import { Toolbar } from './Toolbar';

export interface EditorHandle {
  focus: () => void;
}

interface Props {
  initialContent: string;
  onChange: (markdown: string) => void;
}

export const VisualEditor = forwardRef<EditorHandle, Props>(function VisualEditor({ initialContent, onChange }, ref) {
  const extensions = useMemo(() => editorExtensions(), []);
  const editor = useEditor({
    extensions,
    content: initialContent,
    contentType: 'markdown',
    immediatelyRender: true,
    shouldRerenderOnTransaction: false,
    editorProps: { attributes: { class: 'prose', spellcheck: 'true' } },
    onUpdate: ({ editor }) => onChange(editor.getMarkdown()),
  });

  // Focus synchronously: TipTap's focus command waits for an animation frame, which lets
  // fast typing (and background tabs) slip past the editor.
  useImperativeHandle(
    ref,
    () => ({
      focus: () => {
        if (!editor) return;
        const { state, view } = editor;
        view.dispatch(state.tr.setSelection(Selection.atStart(state.doc)));
        view.focus();
      },
    }),
    [editor],
  );

  return (
    <div className="editor visual-editor">
      {editor && <Toolbar editor={editor} />}
      <EditorContent editor={editor} className="editor-surface" />
    </div>
  );
});
