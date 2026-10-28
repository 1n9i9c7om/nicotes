import type { ReactNode } from 'react';
import { setItemChecked, withoutCitations, type ListItem } from '@nicotes/shared';
import { InlineMarkdown } from '../Markdown';
import { plainText, type LayoutProps, type ListBlock } from './types';

/** Only attachments and https images are shown (no tracking pixels over plain http). */
const IMAGE = /^\s*!\[([^\]]*)\]\(((?:\/api\/attachments\/|https:\/\/)[^)\s]+)\)\s*$/;

/** A calm reading view of the whole page; checkboxes can still be ticked. */
export function DocumentLayout({ markdown, blocks, notebookId, onChange, hideSources }: LayoutProps) {
  if (!blocks.length) return <p className="muted layout-empty">This page is empty.</p>;
  const shown = (text: string) => (hideSources ? withoutCitations(text) : text);
  return (
    <div className="layout-document">
      {blocks.map((block) => {
        switch (block.kind) {
          case 'heading': {
            const Tag = (['h2', 'h2', 'h3', 'h4', 'h4', 'h4'] as const)[block.level - 1]!;
            return (
              <Tag key={block.key}>
                <InlineMarkdown text={shown(block.text)} notebookId={notebookId} />
              </Tag>
            );
          }
          case 'paragraph':
            return (
              <p key={block.key}>
                <InlineMarkdown text={shown(block.text)} notebookId={notebookId} />
              </p>
            );
          case 'quote':
            return (
              <blockquote key={block.key}>
                <InlineMarkdown text={shown(block.text.replace(/\n/g, ' '))} notebookId={notebookId} />
              </blockquote>
            );
          case 'code':
            return (
              <pre key={block.key}>
                <code>{block.text}</code>
              </pre>
            );
          case 'image': {
            const m = IMAGE.exec(block.text);
            return m ? <img key={block.key} src={m[2]} alt={m[1]} loading="lazy" /> : null;
          }
          case 'table':
            return <Table key={block.key} text={block.text} notebookId={notebookId} shown={shown} />;
          case 'list':
            return (
              <ListView
                key={block.key}
                list={block}
                notebookId={notebookId}
                shown={shown}
                onToggle={(item) => onChange(setItemChecked(markdown, item, !item.checked))}
              />
            );
        }
      })}
    </div>
  );
}

function ListView({
  list,
  notebookId,
  onToggle,
  shown,
}: {
  list: ListBlock;
  notebookId: string;
  onToggle: (item: ListItem) => void;
  shown: (text: string) => string;
}) {
  const Tag = list.ordered ? 'ol' : 'ul';
  return (
    <Tag className={list.items.some((i) => i.checked !== null) ? 'doc-list tasks' : 'doc-list'}>
      {list.items.map((item) => (
        <li key={item.line} style={{ marginLeft: item.depth * 22 }} className={item.checked ? 'done' : undefined}>
          {item.checked !== null && (
            <input
              type="checkbox"
              className="task-check"
              checked={item.checked}
              aria-label={plainText(item.text)}
              onChange={() => onToggle(item)}
            />
          )}
          <span>
            <InlineMarkdown text={shown(item.text)} notebookId={notebookId} />
          </span>
        </li>
      ))}
    </Tag>
  );
}

function Table({ text, notebookId, shown }: { text: string; notebookId: string; shown: (text: string) => string }) {
  const rows = text
    .split('\n')
    .filter((l) => !/^\s*\|?\s*:?-{2,}/.test(l))
    .map((l) =>
      l
        .trim()
        .replace(/^\||\|$/g, '')
        .split('|')
        .map((cell) => cell.trim()),
    );
  const [head, ...body] = rows;
  const cell = (c: string, i: number): ReactNode => <InlineMarkdown key={i} text={shown(c)} notebookId={notebookId} />;
  return (
    <div className="doc-table">
      <table>
        {head && (
          <thead>
            <tr>
              {head.map((c, i) => (
                <th key={i}>{cell(c, i)}</th>
              ))}
            </tr>
          </thead>
        )}
        <tbody>
          {body.map((row, r) => (
            <tr key={r}>
              {row.map((c, i) => (
                <td key={i}>{cell(c, i)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
