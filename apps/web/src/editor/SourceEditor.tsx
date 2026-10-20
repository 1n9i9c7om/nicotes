import { forwardRef, useImperativeHandle, useMemo, useRef } from 'react';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { EditorView } from '@codemirror/view';
import { tags as t } from '@lezer/highlight';
import CodeMirror, { type ReactCodeMirrorRef } from '@uiw/react-codemirror';
import type { EditorEnv } from './extensions';
import { sourceUploads, wikilinkCompletion, wikilinkDecorations } from './sourceLinks';
import type { EditorHandle } from './VisualEditor';

const theme = EditorView.theme(
  {
    '&': { backgroundColor: 'transparent', color: 'var(--text)', fontSize: '15px' },
    '.cm-content': { fontFamily: 'var(--font-mono)', padding: '16px 0 96px', caretColor: 'var(--accent)' },
    '.cm-line': { padding: '0', lineHeight: '1.7' },
    '&.cm-focused': { outline: 'none' },
    '.cm-cursor': { borderLeftColor: 'var(--accent)', borderLeftWidth: '2px' },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
      backgroundColor: 'var(--selection) !important',
    },
    '.cm-activeLine': { backgroundColor: 'transparent' },
    '.cm-gutters': { display: 'none' },
    '.cm-wikilink': { color: 'var(--accent-strong)', borderRadius: '3px', background: 'var(--accent-softer)' },
    '.cm-wikilink.unresolved': { color: 'var(--text-muted)', textDecoration: 'underline dashed' },
    '.cm-tooltip.cm-tooltip-autocomplete': {
      background: 'var(--bg-elev-2)',
      border: '1px solid var(--border-strong)',
      borderRadius: '8px',
      overflow: 'hidden',
    },
    '.cm-tooltip-autocomplete ul li': { padding: '6px 10px !important', fontFamily: 'var(--font-sans)' },
    '.cm-tooltip-autocomplete ul li[aria-selected]': { background: 'var(--accent-soft)', color: 'var(--accent-strong)' },
    '.cm-completionDetail': { color: 'var(--text-faint)', fontStyle: 'normal', marginLeft: '10px' },
  },
  { dark: true },
);

const highlight = HighlightStyle.define([
  { tag: t.heading, color: 'var(--text-strong)', fontWeight: '700' },
  { tag: t.heading1, fontSize: '1.3em' },
  { tag: t.heading2, fontSize: '1.15em' },
  { tag: t.strong, fontWeight: '700', color: 'var(--text-strong)' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: [t.link, t.url], color: 'var(--accent)' },
  { tag: t.monospace, color: 'var(--code)' },
  { tag: [t.processingInstruction, t.meta, t.punctuation, t.contentSeparator], color: 'var(--text-faint)' },
  { tag: t.quote, color: 'var(--text-muted)', fontStyle: 'italic' },
  { tag: t.list, color: 'var(--accent-2)' },
  { tag: [t.keyword, t.operator], color: '#7dd3fc' },
  { tag: [t.string, t.special(t.string)], color: '#86efac' },
  { tag: [t.number, t.bool, t.null], color: '#fbbf24' },
  { tag: [t.comment], color: 'var(--text-faint)', fontStyle: 'italic' },
  { tag: [t.function(t.variableName), t.typeName, t.className], color: '#c4b5fd' },
]);

const baseExtensions = [
  markdown({ base: markdownLanguage, codeLanguages: languages }),
  EditorView.lineWrapping,
  EditorView.contentAttributes.of({ spellcheck: 'true', 'aria-label': 'Markdown source' }),
  theme,
  syntaxHighlighting(highlight),
];

interface Props extends EditorEnv {
  value: string;
  onChange: (markdown: string) => void;
}

export const SourceEditor = forwardRef<EditorHandle, Props>(function SourceEditor(
  { value, onChange, bridge, upload, onUploadError },
  ref,
) {
  const cm = useRef<ReactCodeMirrorRef>(null);
  const extensions = useMemo(
    () => [
      ...baseExtensions,
      ...(bridge ? [wikilinkCompletion(bridge), wikilinkDecorations(bridge)] : []),
      ...(upload ? [sourceUploads(upload, onUploadError ?? console.error)] : []),
    ],
    // Bridge and uploader are stable for the editor's lifetime.
    [],
  );
  useImperativeHandle(ref, () => ({ focus: () => cm.current?.view?.focus() }), []);

  return (
    <div className="editor source-editor">
      <CodeMirror
        ref={cm}
        value={value}
        onChange={onChange}
        theme="none"
        extensions={extensions}
        basicSetup={{
          lineNumbers: false,
          foldGutter: false,
          highlightActiveLine: false,
          highlightActiveLineGutter: false,
          autocompletion: false,
        }}
      />
    </div>
  );
});
