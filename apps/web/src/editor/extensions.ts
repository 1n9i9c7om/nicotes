import { Editor, type Extensions } from '@tiptap/core';
import Image from '@tiptap/extension-image';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import { TableKit } from '@tiptap/extension-table';
import { Placeholder } from '@tiptap/extensions';
import { Markdown } from '@tiptap/markdown';
import StarterKit from '@tiptap/starter-kit';
import { drawingSvg } from '../lib/excalidraw';
import type { LinkBridge } from '../lib/links';
import { AudioPlayers } from './audio';
import { Citations } from './citations';
import { Highlight, TextColor } from './colors';
import { Embed, type DrawingEnv, type EmbeddedPage } from './embed';
import { RecurringTasks } from './recurring';
import { FileUploads, type Uploader } from './uploads';
import { Wikilink } from './wikilink';
import { WikilinkSuggest } from './WikilinkSuggest';

export interface EditorEnv {
  placeholder?: string;
  /** Link resolution/navigation; omitted in tests. */
  bridge?: LinkBridge;
  upload?: Uploader;
  onUploadError?: (error: Error) => void;
  /** Loads pages shown by `![[Page]]` embeds; without it they show as links. */
  loadPage?: (pageId: string) => Promise<EmbeddedPage | null>;
  /** How deep in embeds this editor is (0 for the page itself). */
  depth?: number;
  /** Adding and editing drawings in the page; without it they are only shown. */
  drawings?: DrawingEnv;
}

/** A read-only editor showing an embedded page inside another one. */
function embeddedEditor(env: EditorEnv) {
  return (element: HTMLElement, markdown: string) =>
    new Editor({
      element,
      extensions: editorExtensions({ bridge: env.bridge, loadPage: env.loadPage, depth: (env.depth ?? 0) + 1 }),
      content: markdown,
      contentType: 'markdown',
      editable: false,
      editorProps: { attributes: { class: 'prose' } },
    });
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
    RecurringTasks,
    TableKit.configure({ table: { resizable: false } }),
    Image.configure({ allowBase64: false }),
    Highlight,
    TextColor,
    Placeholder.configure({ placeholder: env.placeholder ?? 'Start writing… Type [[ to link a page.' }),
    Wikilink.configure({ bridge: env.bridge ?? null }),
    Embed.configure({ bridge: env.bridge ?? null, load: env.loadPage ?? null, render: embeddedEditor(env), depth: env.depth ?? 0, picture: drawingSvg, drawings: env.drawings ?? null }),
    WikilinkSuggest.configure({ bridge: env.bridge ?? null }),
    FileUploads.configure({ upload: env.upload ?? null, onError: env.onUploadError ?? console.error }),
    Citations,
    AudioPlayers,
    Markdown.configure({ markedOptions: { gfm: true } }),
  ];
}
