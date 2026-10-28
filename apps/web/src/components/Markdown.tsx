import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { HIGHLIGHT_SOURCE, MARK_SOURCE, resolveWikilink, SPAN_SOURCE } from '@nicotes/shared';
import { useLinkContext } from '../lib/links';
import { parseBlocks } from '../lib/markdown';

const INLINE = new RegExp(
  [
    /`([^`]+)`|\*\*(.+?)\*\*|__(.+?)__|(?<![\w*])\*(?!\s)(.+?)\*(?!\w)|(?<!\w)_(?!\s)(.+?)_(?!\w)|\[\[([^[\]|\n]+?)(?:\|([^[\]\n]+?))?\]\]|\[(\d+(?:\s*,\s*\d+)*)\](?!\()|\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/
      .source,
    // Highlights and coloured text (palette names only): groups 11, 12–13 and 14–15.
    HIGHLIGHT_SOURCE,
    MARK_SOURCE,
    SPAN_SOURCE,
  ].join('|'),
  'g',
);

interface InlineEnv {
  linkTo: (target: string) => string | null;
  cite?: (n: number, key: string) => ReactNode;
}

function inline(text: string, env: InlineEnv, keyPrefix = ''): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const key = `${keyPrefix}${m.index}`;
    if (m[1] !== undefined) out.push(<code key={key}>{m[1]}</code>);
    else if (m[2] !== undefined || m[3] !== undefined) out.push(<strong key={key}>{inline(m[2] ?? m[3]!, env, `${key}-`)}</strong>);
    else if (m[4] !== undefined || m[5] !== undefined) out.push(<em key={key}>{inline(m[4] ?? m[5]!, env, `${key}-`)}</em>);
    else if (m[6] !== undefined) {
      const href = env.linkTo(m[6].trim());
      const label = (m[7] ?? m[6]).trim();
      out.push(
        href ? (
          <Link key={key} to={href} className="md-wikilink">
            {label}
          </Link>
        ) : (
          <span key={key} className="md-wikilink missing">
            {label}
          </span>
        ),
      );
    } else if (m[8] !== undefined) {
      const numbers = m[8].split(',').map((n) => Number(n.trim()));
      out.push(...(env.cite ? numbers.map((n, i) => env.cite!(n, `${key}-${i}`)) : [m[0]]));
    } else if (m[9] !== undefined) {
      out.push(
        <a key={key} href={m[10]} target="_blank" rel="noopener noreferrer">
          {m[9]}
        </a>,
      );
    } else if (m[11] !== undefined || m[13] !== undefined) {
      out.push(
        <mark key={key} className={`hl-${m[12] ?? 'yellow'}`}>
          {inline(m[11] ?? m[13]!, env, `${key}-`)}
        </mark>,
      );
    } else if (m[15] !== undefined) {
      out.push(
        <span key={key} className={`tc-${m[14]}`}>
          {inline(m[15], env, `${key}-`)}
        </span>,
      );
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function List({ items, ordered, env }: { items: { depth: number; text: string }[]; ordered: boolean; env: InlineEnv }) {
  // Items deeper than the first one nest under the item before them.
  const top: { text: string; children: { depth: number; text: string }[] }[] = [];
  const base = Math.min(...items.map((i) => i.depth));
  for (const item of items) {
    if (item.depth > base && top.length) top.at(-1)!.children.push(item);
    else top.push({ text: item.text, children: [] });
  }
  const Tag = ordered ? 'ol' : 'ul';
  return (
    <Tag>
      {top.map((item, i) => (
        <li key={i}>
          {inline(item.text, env)}
          {item.children.length > 0 && <List items={item.children} ordered={false} env={env} />}
        </li>
      ))}
    </Tag>
  );
}

/** One line of Markdown (emphasis, code, links, [[wikilinks]]) as React elements. */
export function InlineMarkdown({ text, notebookId }: { text: string; notebookId?: string }) {
  const ctx = useLinkContext();
  const env: InlineEnv = {
    linkTo: (target) => {
      const page = resolveWikilink(ctx, target, notebookId);
      return page ? `/p/${page.id}` : null;
    },
  };
  return <>{inline(text, env)}</>;
}

/**
 * Renders the Markdown subset that AI answers use (paragraphs, headings, lists, quotes, code,
 * emphasis, links, [[wikilinks]], [n] citations and palette colours) as React elements, so it can
 * never inject HTML.
 */
export function Markdown({
  text,
  notebookId,
  cite,
}: {
  text: string;
  /** Wikilinks resolve as if written in this notebook. */
  notebookId?: string;
  cite?: (n: number, key: string) => ReactNode;
}) {
  const ctx = useLinkContext();
  const env: InlineEnv = {
    linkTo: (target) => {
      const page = resolveWikilink(ctx, target, notebookId);
      return page ? `/p/${page.id}` : null;
    },
    cite,
  };
  return (
    <div className="markdown">
      {parseBlocks(text).map((block, i) => {
        switch (block.kind) {
          case 'heading': {
            const Tag = block.level <= 2 ? 'h3' : 'h4';
            return <Tag key={i}>{inline(block.text, env)}</Tag>;
          }
          case 'paragraph':
            return <p key={i}>{inline(block.text, env)}</p>;
          case 'quote':
            return <blockquote key={i}>{inline(block.text, env)}</blockquote>;
          case 'code':
            return (
              <pre key={i}>
                <code>{block.text}</code>
              </pre>
            );
          case 'list':
            return <List key={i} items={block.items} ordered={block.ordered} env={env} />;
        }
      })}
    </div>
  );
}
