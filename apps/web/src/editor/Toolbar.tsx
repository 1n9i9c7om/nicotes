import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Selection } from '@tiptap/pm/state';
import { useEditorState, type Editor } from '@tiptap/react';
import { COLOR_LABELS, COLORS, type Color } from '@nicotes/shared';
import { duration, recordingSupported, VoiceRecorder } from '../components/VoiceRecorder';
import { api } from '../lib/api';
import { useSettings } from '../lib/queries';
import type { DrawingEnv } from './embed';
import type { Uploader } from './uploads';
import { isImage } from './uploads';
import {
  Bold,
  Code,
  Heading1,
  Heading2,
  Heading3,
  Highlighter,
  Italic,
  Link2,
  List,
  ListChecks,
  ListOrdered,
  Loader2,
  Mic,
  Minus,
  Paperclip,
  PenTool,
  Quote,
  Redo2,
  SquareCode,
  Strikethrough,
  Table,
  Undo2,
  X,
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

/** Swatches for one colour kind; "None" removes it. */
function ColorRow({
  label,
  kind,
  current,
  onPick,
}: {
  label: string;
  kind: 'hl' | 'tc';
  current: Color | null;
  onPick: (color: Color | null) => void;
}) {
  return (
    <div className="color-row" role="group" aria-label={label}>
      <span className="color-row-label">{label}</span>
      {COLORS.map((color) => (
        <button
          key={color}
          type="button"
          className={`swatch ${kind}-${color}${current === color ? ' active' : ''}`}
          aria-label={`${COLOR_LABELS[color]} ${kind === 'hl' ? 'highlight' : 'text'}`}
          aria-pressed={current === color}
          title={COLOR_LABELS[color]}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onPick(color)}
        >
          A
        </button>
      ))}
      <button
        type="button"
        className="swatch none"
        aria-label={`No ${kind === 'hl' ? 'highlight' : 'text colour'}`}
        title="None"
        disabled={!current}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => onPick(null)}
      >
        <X size={14} />
      </button>
    </div>
  );
}

interface ToolbarProps {
  editor: Editor;
  upload?: Uploader;
  onUploadError?: (error: Error) => void;
  drawings?: DrawingEnv;
}

/** Adds a quote with `text` after the block that holds the link to `href`. */
function insertAfterLink(editor: Editor, href: string, text: string) {
  let after: number | null = null;
  editor.state.doc.descendants((node, pos) => {
    if (after !== null) return false;
    if (node.isText && node.marks.some((m) => m.type.name === 'link' && m.attrs.href === href)) {
      const $pos = editor.state.doc.resolve(pos);
      after = $pos.after($pos.depth);
    }
  });
  if (after === null) return;
  editor
    .chain()
    .insertContentAt(after, { type: 'blockquote', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] })
    .run();
}

export function Toolbar({ editor, upload, onUploadError, drawings }: ToolbarProps) {
  const [linkOpen, setLinkOpen] = useState(false);
  const [recording, setRecording] = useState(false);
  const [voiceBusy, setVoiceBusy] = useState<string | null>(null);
  const settings = useSettings();
  const canTranscribe = !!settings.data?.transcription.url;
  const [colorsOpen, setColorsOpen] = useState(false);
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

  /** A finished recording: kept as an attachment, linked at the cursor, then written down. */
  const addVoiceNote = async (file: File, seconds: number) => {
    if (!upload) return;
    try {
      setVoiceBusy('Saving the recording…');
      const att = await upload(file);
      const link = { type: 'text', text: `🎙️ Voice note (${duration(seconds)})`, marks: [{ type: 'link', attrs: { href: att.url } }] };
      // On an empty line it goes there; otherwise into a paragraph of its own below.
      const { $from } = editor.state.selection;
      if ($from.parent.isTextblock && $from.parent.content.size === 0) editor.chain().focus().insertContent(link).run();
      else editor.chain().focus().insertContentAt($from.after($from.depth), { type: 'paragraph', content: [link] }).run();
      if (!canTranscribe) return;
      setVoiceBusy('Writing down what you said…');
      const { text } = await api.post<{ text: string }>(`/attachments/${att.id}/transcribe`);
      if (text) insertAfterLink(editor, att.url, text);
    } catch (error) {
      onUploadError?.(new Error(`Voice note: ${(error as Error).message}`));
    } finally {
      setVoiceBusy(null);
    }
  };

  // Back from a drawing, typing goes on where it was.
  useEffect(() => drawings?.subscribe(() => editor.commands.focus()), [drawings, editor]);

  /** A new drawing, on an empty line where the cursor is, or else below that block; then draw. */
  const addDrawing = async () => {
    if (!drawings) return;
    try {
      const { id, target } = await drawings.create();
      const { $from, $to } = editor.state.selection;
      const empty = $from.depth === 1 && $from.parent.isTextblock && $from.parent.content.size === 0;
      const at = empty ? $from.before() : $to.depth ? $to.after(1) : $to.pos;
      const where = empty ? { from: at, to: $from.after() } : at;
      editor.chain().focus().insertContentAt(where, { type: 'embed', attrs: { target, label: null } }).run();
      // The cursor goes on below it, or typing would replace the drawing.
      const { state, view } = editor;
      view.dispatch(state.tr.setSelection(Selection.near(state.doc.resolve(at + 1))));
      drawings.open(id);
    } catch (error) {
      onUploadError?.(new Error(`Drawing: ${(error as Error).message}`));
    }
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
      highlight: e.isActive('highlight') ? (e.getAttributes('highlight').color as Color) : null,
      textColor: e.isActive('textColor') ? (e.getAttributes('textColor').color as Color) : null,
      table: e.isActive('table'),
      canUndo: e.can().undo(),
      canRedo: e.can().redo(),
    }),
  });

  const chain = () => editor.chain().focus();

  const openLink = () => {
    setHref((editor.getAttributes('link').href as string | undefined) ?? '');
    setColorsOpen(false);
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
        <ToolButton
          label="Highlight and text colour"
          active={colorsOpen || !!state.highlight || !!state.textColor}
          onClick={() => {
            setLinkOpen(false);
            setColorsOpen((open) => !open);
          }}
        >
          <Highlighter size={16} />
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
        {drawings && (
          <ToolButton label="Add a drawing" onClick={() => void addDrawing()}>
            <PenTool size={16} />
          </ToolButton>
        )}
        {upload && recordingSupported() && (
          <ToolButton label="Record a voice note" active={recording} disabled={!!voiceBusy} onClick={() => setRecording(!recording)}>
            <Mic size={16} />
          </ToolButton>
        )}
      </div>

      {recording && <VoiceRecorder onDone={(file, seconds) => void addVoiceNote(file, seconds)} onClose={() => setRecording(false)} />}
      {voiceBusy && (
        <div className="voice-recorder" role="status">
          <span className="voice-status">
            <Loader2 size={15} className="spin" /> {voiceBusy}
          </span>
        </div>
      )}

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

      {colorsOpen && (
        <div className="color-popover" onKeyDown={(e) => e.key === 'Escape' && setColorsOpen(false)}>
          <ColorRow
            label="Highlight"
            kind="hl"
            current={state.highlight}
            onPick={(color) => (color ? chain().setHighlight(color).run() : chain().unsetHighlight().run())}
          />
          <ColorRow
            label="Text"
            kind="tc"
            current={state.textColor}
            onPick={(color) => (color ? chain().setTextColor(color).run() : chain().unsetTextColor().run())}
          />
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
