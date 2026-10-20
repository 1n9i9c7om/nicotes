import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { FileText, Hash, MessageCircleQuestion, Search, Sparkles, TextSearch } from 'lucide-react';
import { MATCH_END, MATCH_START } from '@nicotes/shared';
import { plainExcerpt } from '../lib/format';
import { fuzzyFilter } from '../lib/fuzzy';
import { searchPages, semanticSearch, useNotebooks, usePages, useSettings, useTags } from '../lib/queries';
import { ancestors, buildTree, displayTitle } from '../lib/tree';

interface Item {
  key: string;
  kind: 'page' | 'tag' | 'content' | 'meaning' | 'ask';
  label: string;
  detail: ReactNode;
  href: string;
}

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

/** Renders a search excerpt, turning the server's match markers into <mark>. */
export function Excerpt({ text }: { text: string }) {
  const parts = plainExcerpt(text).split(MATCH_START);
  return (
    <>
      {parts.map((part, i) => {
        if (i === 0) return <Fragment key={i}>{part}</Fragment>;
        const [hit, rest = ''] = part.split(MATCH_END);
        return (
          <Fragment key={i}>
            <mark>{hit}</mark>
            {rest}
          </Fragment>
        );
      })}
    </>
  );
}

const ICONS = { page: FileText, tag: Hash, content: TextSearch, meaning: Sparkles, ask: MessageCircleQuestion };

export function CommandPalette({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const pages = usePages();
  const notebooks = useNotebooks();
  const tags = useTags();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const list = useRef<HTMLUListElement>(null);
  const q = query.trim();
  const debounced = useDebounced(q, 200);
  // Searching by meaning costs an embedding call, so it waits for a longer pause.
  const slow = useDebounced(q, 450);
  const settings = useSettings();
  const semanticOn = !!settings.data?.semantic.enabled;

  const content = useQuery({
    queryKey: ['search', debounced],
    queryFn: () => searchPages(debounced),
    enabled: debounced.length >= 2 || debounced.startsWith('#'),
    staleTime: 10_000,
  });

  const meaning = useQuery({
    queryKey: ['semantic-search', slow],
    queryFn: () => semanticSearch(slow),
    enabled: semanticOn && slow.length >= 3 && !slow.startsWith('#'),
    staleTime: 60_000,
  });

  const tree = useMemo(() => buildTree(pages.data ?? []), [pages.data]);
  const notebookTitle = useMemo(() => new Map(notebooks.data?.map((n) => [n.id, n.title])), [notebooks.data]);

  const items = useMemo<Item[]>(() => {
    const where = (id: string, notebookId: string) =>
      [notebookTitle.get(notebookId), ...ancestors(tree, id).map((a) => displayTitle(a.title))].join(' › ');
    const all = pages.data ?? [];
    const titleSource = q ? all : [...all].sort((a, b) => b.updatedAt - a.updatedAt);
    const isTagQuery = q.startsWith('#');

    const pageItems: Item[] = isTagQuery
      ? []
      : fuzzyFilter(titleSource, q, (p) => displayTitle(p.title), 8).map((p) => ({
          key: `p:${p.id}`,
          kind: 'page',
          label: displayTitle(p.title),
          detail: where(p.id, p.notebookId),
          href: `/p/${p.id}`,
        }));
    const tagItems: Item[] = q
      ? fuzzyFilter(tags.data ?? [], q.replace(/^#/, ''), (t) => t.name, isTagQuery ? 8 : 3).map((t) => ({
          key: `t:${t.name}`,
          kind: 'tag',
          label: `#${t.name}`,
          detail: `${t.count} ${t.count === 1 ? 'page' : 'pages'}`,
          href: `/t/${encodeURIComponent(t.name)}`,
        }))
      : [];
    const shown = new Set(pageItems.map((i) => i.key));
    const contentItems: Item[] =
      q && debounced === q
        ? (content.data ?? [])
            .filter((r) => !shown.has(`p:${r.id}`))
            .slice(0, 8)
            .map((r) => ({
              key: `c:${r.id}`,
              kind: 'content',
              label: displayTitle(r.title),
              detail: r.excerpt ? <Excerpt text={r.excerpt} /> : where(r.id, r.notebookId),
              href: `/p/${r.id}`,
            }))
        : [];
    for (const item of contentItems) shown.add(`p:${item.key.slice(2)}`);
    const meaningItems: Item[] =
      q && slow === q
        ? (meaning.data?.results ?? [])
            .filter((r) => !shown.has(`p:${r.id}`))
            .slice(0, 5)
            .map((r) => ({
              key: `m:${r.id}`,
              kind: 'meaning',
              label: displayTitle(r.title),
              detail: plainExcerpt(r.excerpt) || where(r.id, r.notebookId),
              href: `/p/${r.id}`,
            }))
        : [];
    // Questions can go straight to "Ask your notes".
    const askItems: Item[] =
      semanticOn && q.length >= 3 && !isTagQuery && (q.endsWith('?') || q.split(/\s+/).length >= 3)
        ? [{ key: 'ask', kind: 'ask', label: `Ask your notes: “${q}”`, detail: '', href: `/ask?q=${encodeURIComponent(q)}` }]
        : [];
    return [...pageItems, ...tagItems, ...contentItems, ...meaningItems, ...askItems];
  }, [q, debounced, slow, pages.data, tags.data, content.data, meaning.data, semanticOn, tree, notebookTitle]);

  useEffect(() => setActive(0), [q]);
  useEffect(() => {
    list.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const open = (item: Item | undefined) => {
    if (!item) return;
    navigate(item.href);
    onClose();
  };

  const sectionTitle = (item: Item, i: number) => {
    if (i > 0 && items[i - 1]!.kind === item.kind) return null;
    const titles = { page: q ? 'Pages' : 'Recent', tag: 'Tags', content: 'In page content', meaning: 'By meaning', ask: 'Ask' };
    return <li className="palette-section">{titles[item.kind]}</li>;
  };

  return createPortal(
    <div className="modal-backdrop palette-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="Search">
        <div className="palette-field">
          <Search size={18} />
          <input
            className="palette-input"
            autoFocus
            placeholder="Search pages, #tags and content…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActive((i) => Math.min(i + 1, items.length - 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActive((i) => Math.max(i - 1, 0));
              } else if (e.key === 'Enter') {
                e.preventDefault();
                open(items[active]);
              } else if (e.key === 'Escape') {
                onClose();
              }
            }}
          />
          <kbd>Esc</kbd>
        </div>
        <ul className="palette-list" ref={list} role="listbox">
          {items.map((item, i) => {
            const Icon = ICONS[item.kind];
            return (
              <Fragment key={item.key}>
                {sectionTitle(item, i)}
                <li
                  role="option"
                  aria-selected={i === active}
                  className={`palette-item ${item.kind}${i === active ? ' active' : ''}`}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => open(item)}
                >
                  <Icon size={16} className="palette-icon" />
                  <span className="palette-label">{item.label}</span>
                  <span className="palette-detail">{item.detail}</span>
                </li>
              </Fragment>
            );
          })}
          {items.length === 0 && (
            <li className="palette-empty">{content.isFetching ? 'Searching…' : q ? 'Nothing found' : 'No pages yet'}</li>
          )}
        </ul>
      </div>
    </div>,
    document.body,
  );
}
