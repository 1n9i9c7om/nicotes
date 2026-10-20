import { useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useEditorState, type Editor } from '@tiptap/react';
import type { Uploader } from './uploads';
import { isImage } from './uploads';
import {
  Bold,
  Code,
  Heading1,
  Heading2,
  Heading3,
  Italic,
  Link2,
  List,
  ListChecks,
  ListOrdered,
  Minus,
  Paperclip,
  Quote,
  Redo2,
  SquareCode,
  Strikethrough,
  Table,
  Undo2,
} from 'lucide-react';

function ToolButton({
  label,
  active,
  disabled,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={active ? 'tool-btn active' : 'tool-btn'}
      aria-label={label}
      aria-pressed={active}
      title={label}
      disabled={disabled}
      // Keep the editor selection when clicking toolbar buttons.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

interface ToolbarProps {
  editor: Editor;
  upload?: Uploader;
  onUploadError?: (error: Error) => void;
}

export function Toolbar({ editor, upload, onUploadError }: ToolbarProps) {
  const [linkOpen, setLinkOpen] = useState(false);
  const [href, setHref] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);

  const attachFiles = async (files: FileList | null) => {
    if (!upload || !files) return;
    for (const file of files) {
      try {
        const att = await upload(file);
        const content = isImage(att.mime)
          ? { type: 'image', attrs: { src: att.url, alt: att.filename } }
          : { type: 'text', text: att.filename, marks: [{ type: 'link', attrs: { href: att.url } }] };
        editor.chain().focus().insertContent(content).run();
      } catch (error) {
        onUploadError?.(error as Error);
      }
    }
    if (fileInput.current) fileInput.current.value = '';
  };

  const state = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive('bold'),
      italic: e.isActive('italic'),
      strike: e.isActive('strike'),
      code: e.isActive('code'),
      h1: e.isActive('heading', { level: 1 }),
      h2: e.isActive('heading', { level: 2 }),
      h3: e.isActive('heading', { level: 3 }),
      bullet: e.isActive('bulletList'),
      ordered: e.isActive('orderedList'),
      task: e.isActive('taskList'),
      quote: e.isActive('blockquote'),
      codeBlock: e.isActive('codeBlock'),
      link: e.isActive('link'),
      table: e.isActive('table'),
      canUndo: e.can().undo(),
      canRedo: e.can().redo(),
    }),
  });

  const chain = () => editor.chain().focus();

  const openLink = () => {
    setHref((editor.getAttributes('link').href as string | undefined) ?? '');
    setLinkOpen(true);
  };

  const applyLink = (e: FormEvent) => {
    e.preventDefault();
    const url = href.trim();
    if (url) chain().extendMarkRange('link').setLink({ href: url }).run();
    else chain().extendMarkRange('link').unsetLink().run();
    setLinkOpen(false);
  };

  return (
    <div className="toolbar" role="toolbar" aria-label="Formatting">
      <div className="tool-group">
        <ToolButton label="Undo" disabled={!state.canUndo} onClick={() => chain().undo().run()}>
          <Undo2 size={16} />
        </ToolButton>
        <ToolButton label="Redo" disabled={!state.canRedo} onClick={() => chain().redo().run()}>
          <Redo2 size={16} />
        </ToolButton>
      </div>
      <div className="tool-group">
        <ToolButton label="Heading 1" active={state.h1} onClick={() => chain().toggleHeading({ level: 1 }).run()}>
          <Heading1 size={16} />
        </ToolButton>
        <ToolButton label="Heading 2" active={state.h2} onClick={() => chain().toggleHeading({ level: 2 }).run()}>
          <Heading2 size={16} />
        </ToolButton>
        <ToolButton label="Heading 3" active={state.h3} onClick={() => chain().toggleHeading({ level: 3 }).run()}>
          <Heading3 size={16} />
        </ToolButton>
      </div>
      <div className="tool-group">
        <ToolButton label="Bold" active={state.bold} onClick={() => chain().toggleBold().run()}>
          <Bold size={16} />
        </ToolButton>
        <ToolButton label="Italic" active={state.italic} onClick={() => chain().toggleItalic().run()}>
          <Italic size={16} />
        </ToolButton>
        <ToolButton label="Strikethrough" active={state.strike} onClick={() => chain().toggleStrike().run()}>
          <Strikethrough size={16} />
        </ToolButton>
        <ToolButton label="Inline code" active={state.code} onClick={() => chain().toggleCode().run()}>
          <Code size={16} />
        </ToolButton>
        <ToolButton label="Link" active={state.link} onClick={openLink}>
          <Link2 size={16} />
        </ToolButton>
      </div>
      <div className="tool-group">
        <ToolButton label="Bullet list" active={state.bullet} onClick={() => chain().toggleBulletList().run()}>
          <List size={16} />
        </ToolButton>
        <ToolButton label="Numbered list" active={state.ordered} onClick={() => chain().toggleOrderedList().run()}>
          <ListOrdered size={16} />
        </ToolButton>
        <ToolButton label="Checklist" active={state.task} onClick={() => chain().toggleTaskList().run()}>
          <ListChecks size={16} />
        </ToolButton>
      </div>
      <div className="tool-group">
        <ToolButton label="Quote" active={state.quote} onClick={() => chain().toggleBlockquote().run()}>
          <Quote size={16} />
        </ToolButton>
        <ToolButton label="Code block" active={state.codeBlock} onClick={() => chain().toggleCodeBlock().run()}>
          <SquareCode size={16} />
        </ToolButton>
        <ToolButton
          label="Table"
          active={state.table}
          onClick={() => chain().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}
        >
          <Table size={16} />
        </ToolButton>
        <ToolButton label="Divider" onClick={() => chain().setHorizontalRule().run()}>
          <Minus size={16} />
        </ToolButton>
        {upload && (
          <ToolButton label="Attach image or file" onClick={() => fileInput.current?.click()}>
            <Paperclip size={16} />
          </ToolButton>
        )}
        <input ref={fileInput} type="file" multiple hidden onChange={(e) => void attachFiles(e.target.files)} />
      </div>

      {state.table && (
        <div className="tool-group table-tools">
          <button type="button" className="tool-text" onClick={() => chain().addRowAfter().run()}>
            + Row
          </button>
          <button type="button" className="tool-text" onClick={() => chain().addColumnAfter().run()}>
            + Column
          </button>
          <button type="button" className="tool-text" onClick={() => chain().deleteRow().run()}>
            − Row
          </button>
          <button type="button" className="tool-text" onClick={() => chain().deleteColumn().run()}>
            − Column
          </button>
          <button type="button" className="tool-text danger" onClick={() => chain().deleteTable().run()}>
            Delete table
          </button>
        </div>
      )}

      {linkOpen && (
        <form className="link-popover" onSubmit={applyLink}>
          <input
            autoFocus
            type="url"
            inputMode="url"
            placeholder="https://…"
            value={href}
            onChange={(e) => setHref(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && setLinkOpen(false)}
          />
          <button className="btn btn-primary btn-sm">{href.trim() ? 'Apply' : 'Remove'}</button>
          <button type="button" className="btn btn-sm" onClick={() => setLinkOpen(false)}>
            Cancel
          </button>
        </form>
      )}
    </div>
  );
}
