import { autocompletion, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete';
import { Decoration, EditorView, MatchDecorator, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import type { LinkBridge } from '../lib/links';
import { attachmentMarkdown, type Uploader } from './uploads';

const WIKILINK = /\[\[([^[\]|\n]+?)(?:\|([^[\]\n]+?))?\]\]/g;

/** `[[` autocompletion over page titles. */
export function wikilinkCompletion(bridge: LinkBridge) {
  return autocompletion({
    activateOnTyping: true,
    icons: false,
    override: [
      (context: CompletionContext): CompletionResult | null => {
        const match = context.matchBefore(/\[\[[^[\]|\n]*/);
        if (!match) return null;
        const query = match.text.slice(2);
        const closing = context.state.sliceDoc(context.pos, context.pos + 2) === ']]';
        return {
          from: match.from + 2,
          filter: false,
          options: bridge.suggest(query).map((s) => ({
            label: s.title,
            detail: s.where,
            apply: closing ? s.target : `${s.target}]]`,
          })),
        };
      },
    ],
  });
}

/** Highlights wikilinks; Ctrl/Cmd+click opens them. */
export function wikilinkDecorations(bridge: LinkBridge) {
  const decorator = new MatchDecorator({
    regexp: WIKILINK,
    decoration: (match) =>
      Decoration.mark({
        class: bridge.resolve(match[1]!.trim()) ? 'cm-wikilink' : 'cm-wikilink unresolved',
        attributes: { title: 'Ctrl/Cmd+click to open' },
      }),
  });

  return [
    ViewPlugin.fromClass(
      class {
        decorations: DecorationSet;
        private unsubscribe: () => void;
        constructor(view: EditorView) {
          this.decorations = decorator.createDeco(view);
          // Re-colour links when pages are created or renamed.
          this.unsubscribe = bridge.subscribe(() => {
            this.decorations = decorator.createDeco(view);
            view.dispatch({});
          });
        }
        update(update: ViewUpdate) {
          this.decorations = decorator.updateDeco(update, this.decorations);
        }
        destroy() {
          this.unsubscribe();
        }
      },
      { decorations: (v) => v.decorations },
    ),
    EditorView.domEventHandlers({
      mousedown: (event, view) => {
        if (!(event.ctrlKey || event.metaKey)) return false;
        const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
        if (pos === null) return false;
        const line = view.state.doc.lineAt(pos);
        for (const m of line.text.matchAll(WIKILINK)) {
          const from = line.from + m.index;
          if (pos >= from && pos <= from + m[0].length) {
            event.preventDefault();
            bridge.open(m[1]!.trim());
            return true;
          }
        }
        return false;
      },
    }),
  ];
}

/** Uploads pasted/dropped files and inserts their Markdown at the cursor/drop point. */
export function sourceUploads(upload: Uploader, onError: (e: Error) => void) {
  const insert = async (view: EditorView, files: File[], pos: number) => {
    for (const file of files) {
      try {
        const md = attachmentMarkdown(await upload(file));
        const at = Math.min(pos, view.state.doc.length);
        view.dispatch({ changes: { from: at, insert: md }, selection: { anchor: at + md.length } });
        pos = at + md.length;
      } catch (error) {
        onError(error as Error);
      }
    }
  };
  return EditorView.domEventHandlers({
    paste: (event, view) => {
      const files = [...(event.clipboardData?.files ?? [])];
      if (!files.length) return false;
      event.preventDefault();
      void insert(view, files, view.state.selection.main.head);
      return true;
    },
    drop: (event, view) => {
      const files = [...(event.dataTransfer?.files ?? [])];
      if (!files.length) return false;
      event.preventDefault();
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? view.state.selection.main.head;
      void insert(view, files, pos);
      return true;
    },
  });
}
