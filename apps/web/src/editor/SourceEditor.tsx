import { forwardRef, useImperativeHandle, useRef } from 'react';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { EditorView } from '@codemirror/view';
import { tags as t } from '@lezer/highlight';
import CodeMirror, { type ReactCodeMirrorRef } from '@uiw/react-codemirror';
import type { EditorHandle } from './VisualEditor';

const theme = EditorView.theme(
  {
    '&': { backgroundColor: 'transparent', color: 'var(--text)', fontSize: '15px' },
    '.cm-content': { fontFamily: 'var(--font-mono)', padding: '16px 0 40vh', caretColor: 'var(--accent)' },
    '.cm-line': { padding: '0', lineHeight: '1.7' },
    '&.cm-focused': { outline: 'none' },
    '.cm-cursor': { borderLeftColor: 'var(--accent)', borderLeftWidth: '2px' },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
      backgroundColor: 'var(--selection) !important',
    },
    '.cm-activeLine': { backgroundColor: 'transparent' },
    '.cm-gutters': { display: 'none' },
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

const extensions = [
  markdown({ base: markdownLanguage, codeLanguages: languages }),
  EditorView.lineWrapping,
  EditorView.contentAttributes.of({ spellcheck: 'true', 'aria-label': 'Markdown source' }),
  theme,
  syntaxHighlighting(highlight),
];

interface Props {
  value: string;
  onChange: (markdown: string) => void;
}

export const SourceEditor = forwardRef<EditorHandle, Props>(function SourceEditor({ value, onChange }, ref) {
  const cm = useRef<ReactCodeMirrorRef>(null);
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
