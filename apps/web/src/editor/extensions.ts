import type { Extensions } from '@tiptap/core';
import Image from '@tiptap/extension-image';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import { TableKit } from '@tiptap/extension-table';
import { Placeholder } from '@tiptap/extensions';
import { Markdown } from '@tiptap/markdown';
import StarterKit from '@tiptap/starter-kit';
import type { LinkBridge } from '../lib/links';
import { FileUploads, type Uploader } from './uploads';
import { Wikilink } from './wikilink';
import { WikilinkSuggest } from './WikilinkSuggest';

export interface EditorEnv {
  placeholder?: string;
  /** Link resolution/navigation; omitted in tests. */
  bridge?: LinkBridge;
  upload?: Uploader;
  onUploadError?: (error: Error) => void;
}

/** Extensions for the visual editor. Markdown is the storage format, so every node must round-trip. */
export function editorExtensions(env: EditorEnv = {}): Extensions {
  return [
    StarterKit.configure({
      link: { openOnClick: false, autolink: true, defaultProtocol: 'https' },
      heading: { levels: [1, 2, 3, 4, 5, 6] },
    }),
    TaskList,
    TaskItem.configure({ nested: true }),
    TableKit.configure({ table: { resizable: false } }),
    Image.configure({ allowBase64: false }),
    Placeholder.configure({ placeholder: env.placeholder ?? 'Start writing… Type [[ to link a page.' }),
    Wikilink.configure({ bridge: env.bridge ?? null }),
    WikilinkSuggest.configure({ bridge: env.bridge ?? null }),
    FileUploads.configure({ upload: env.upload ?? null, onError: env.onUploadError ?? console.error }),
    Markdown.configure({ markedOptions: { gfm: true } }),
  ];
}
