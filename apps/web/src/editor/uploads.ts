import { Extension } from '@tiptap/core';
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import type { Attachment } from '@nicotes/shared';

export type Uploader = (file: File) => Promise<Attachment>;

export const isImage = (mime: string) => mime.startsWith('image/');

/** Markdown for an uploaded file: an embedded image, or a link to download it. */
export function attachmentMarkdown(att: Attachment): string {
  const text = att.filename.replace(/[[\]]/g, '');
  return isImage(att.mime) ? `![${text}](${att.url})` : `[${text}](${att.url})`;
}

/**
 * Uploads pasted or dropped files and inserts them at the selection (paste) or at the drop
 * position. Replacing the selection lets ProseMirror split paragraphs for block images.
 */
async function insertFiles(
  view: EditorView,
  files: File[],
  dropPos: number | null,
  upload: Uploader,
  onError: (e: Error) => void,
) {
  for (const [i, file] of files.entries()) {
    try {
      const att = await upload(file);
      const { schema } = view.state;
      let tr = view.state.tr;
      if (i === 0 && dropPos !== null) {
        tr = tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(dropPos, tr.doc.content.size))));
      }
      tr = isImage(att.mime)
        ? tr.replaceSelectionWith(schema.nodes.image!.create({ src: att.url, alt: att.filename }))
        : tr.replaceSelectionWith(schema.text(att.filename, [schema.marks.link!.create({ href: att.url })]), false);
      view.dispatch(tr.scrollIntoView());
    } catch (error) {
      onError(error as Error);
    }
  }
}

export const FileUploads = Extension.create<{ upload: Uploader | null; onError: (e: Error) => void }>({
  name: 'fileUploads',

  addOptions() {
    return { upload: null, onError: (e) => console.error(e) };
  },

  addProseMirrorPlugins() {
    const { upload, onError } = this.options;
    if (!upload) return [];
    return [
      new Plugin({
        key: new PluginKey('fileUploads'),
        props: {
          handlePaste: (view, event) => {
            const files = [...(event.clipboardData?.files ?? [])];
            if (!files.length) return false;
            void insertFiles(view, files, null, upload, onError);
            return true;
          },
          handleDrop: (view, event) => {
            const files = [...(event.dataTransfer?.files ?? [])];
            if (!files.length) return false;
            const pos = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos ?? null;
            void insertFiles(view, files, pos, upload, onError);
            return true;
          },
        },
      }),
    ];
  },
});
