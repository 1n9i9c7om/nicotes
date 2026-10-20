import { lazy, Suspense, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { Crosshair, ExternalLink, FilePlus, Maximize2, Search, Waypoints, X } from 'lucide-react';
import type { GraphCanvasHandle } from '../components/graph/GraphCanvas';
import { fuzzyScore } from '../lib/fuzzy';
import { buildGraph, DEFAULT_GRAPH_OPTIONS, type GraphNode, type GraphOptions } from '../lib/graph';
import { useOpenWikilink } from '../lib/links';
import { useGraphLinks, useNotebooks, usePages, useTags } from '../lib/queries';
import { useLocalState } from '../lib/storage';
import { ancestors, buildTree, displayTitle } from '../lib/tree';

const GraphCanvas = lazy(() => import('../components/graph/GraphCanvas'));

type Toggle = 'links' | 'hierarchy' | 'tags' | 'missing' | 'orphans';
const TOGGLES: { key: Toggle; label: string; title: string }[] = [
  { key: 'links', label: 'Links', title: '[[Links]] between pages' },
  { key: 'hierarchy', label: 'Subpages', title: 'Parent → subpage (dashed)' },
  { key: 'tags', label: 'Tags', title: 'Tags as square nodes' },
  { key: 'missing', label: 'Missing', title: 'Links to pages that do not exist yet' },
  { key: 'orphans', label: 'Unlinked', title: 'Pages without any connection' },
];

export function GraphPage() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const pages = usePages();
  const notebooks = useNotebooks();
  const tags = useTags();
  const links = useGraphLinks();
  const canvas = useRef<GraphCanvasHandle>(null);
  const [stored, setStored] = useLocalState<Omit<GraphOptions, 'focus' | 'depth'>>('nicotes.graph', DEFAULT_GRAPH_OPTIONS);
  const [selected, setSelected] = useState<GraphNode | null>(null);
  const [query, setQuery] = useState('');

  const focus = params.get('focus');
  const depth = Number(params.get('depth')) || 2;
  const options: GraphOptions = { ...DEFAULT_GRAPH_OPTIONS, ...stored, focus, depth };
  const setOption = <K extends keyof typeof stored>(key: K, value: (typeof stored)[K]) => setStored({ ...stored, [key]: value });

  const ready = pages.data && notebooks.data && tags.data && links.data;
  const data = useMemo(
    () =>
      ready
        ? buildGraph({ pages: pages.data!, notebooks: notebooks.data!, tags: tags.data!, links: links.data! }, options)
        : { nodes: [], links: [] },
    [ready, pages.data, notebooks.data, tags.data, links.data, JSON.stringify(options)],
  );

  const matches = useMemo(() => {
    const q = query.trim();
    if (!q) return undefined;
    return new Set(data.nodes.filter((n) => fuzzyScore(n.label, q) >= 40).map((n) => n.id));
  }, [query, data.nodes]);

  const tree = useMemo(() => buildTree(pages.data ?? []), [pages.data]);
  const focusPage = focus ? pages.data?.find((p) => p.id === focus) : undefined;
  const notebookOf = (id: string | null) => notebooks.data?.find((n) => n.id === id);
  const fromNotebook = selected?.notebookId ?? notebooks.data?.[0]?.id ?? '';
  const openLink = useOpenWikilink(fromNotebook);

  const open = (node: GraphNode) => {
    if (node.kind === 'page') navigate(`/p/${node.id}`);
    else if (node.kind === 'tag') navigate(`/t/${encodeURIComponent(node.label.slice(1))}`);
    else if (node.target) void openLink(node.target);
  };
  const setFocus = (id: string | null, d = depth) => {
    setSelected(null);
    setParams(id ? { focus: id, depth: String(d) } : {});
  };

  const visibleNotebooks = useMemo(() => {
    const ids = new Set(data.nodes.map((n) => n.notebookId).filter(Boolean));
    return (notebooks.data ?? []).filter((n) => ids.has(n.id));
  }, [data.nodes, notebooks.data]);

  const pageCount = data.nodes.filter((n) => n.kind === 'page').length;

  return (
    <div className="graph-page">
      <div className="graph-panel">
        <div className="graph-panel-head">
          <Waypoints size={18} />
          <h1>Graph</h1>
          <span className="muted graph-stats">
            {pageCount} pages · {data.links.length} connections
          </span>
        </div>

        {focusPage ? (
          <div className="graph-focus">
            <span>
              Around <strong>{displayTitle(focusPage.title)}</strong>
            </span>
            <div className="segmented" role="group" aria-label="Depth">
              {[1, 2, 3].map((d) => (
                <button key={d} className={d === depth ? 'active' : ''} onClick={() => setFocus(focus, d)}>
                  {d} {d === 1 ? 'hop' : 'hops'}
                </button>
              ))}
            </div>
            <button className="icon-btn" aria-label="Show whole graph" title="Show whole graph" onClick={() => setFocus(null)}>
              <X size={16} />
            </button>
          </div>
        ) : (
          <div className="graph-filters">
            <select value={options.notebookId ?? ''} onChange={(e) => setOption('notebookId', e.target.value || null)} aria-label="Notebook">
              <option value="">All notebooks</option>
              {notebooks.data?.map((n) => (
                <option key={n.id} value={n.id}>
                  {n.title}
                </option>
              ))}
            </select>
            <select value={options.tag ?? ''} onChange={(e) => setOption('tag', e.target.value || null)} aria-label="Tag">
              <option value="">Any tag</option>
              {tags.data?.map((t) => (
                <option key={t.name} value={t.name}>
                  #{t.name}
                </option>
              ))}
            </select>
          </div>
        )}

        <div className="chips">
          {TOGGLES.map((t) => (
            <button
              key={t.key}
              type="button"
              role="checkbox"
              aria-checked={options[t.key]}
              title={t.title}
              className={options[t.key] ? 'chip active' : 'chip'}
              onClick={() => setOption(t.key, !options[t.key])}
            >
              {t.label}
            </button>
          ))}
        </div>

        <label className="graph-search">
          <Search size={15} />
          <input
            placeholder="Find a node…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter' || !matches?.size) return;
              const first = data.nodes.find((n) => matches.has(n.id))!;
              setSelected(first);
              canvas.current?.centerOn(first.id);
            }}
          />
          {matches && <span className="muted">{matches.size}</span>}
        </label>
      </div>

      <div className="graph-stage">
        {ready && data.nodes.length === 0 && (
          <div className="graph-empty muted">Nothing to show with these filters. Link pages with [[double brackets]] to connect them.</div>
        )}
        <Suspense fallback={null}>
          {ready && (
            <GraphCanvas
              ref={canvas}
              nodes={data.nodes}
              links={data.links}
              selectedId={selected?.id}
              focusId={focus}
              matches={matches}
              onSelect={setSelected}
              onOpen={open}
            />
          )}
        </Suspense>
        <button className="icon-btn graph-fit" aria-label="Fit to screen" title="Fit to screen" onClick={() => canvas.current?.fit()}>
          <Maximize2 size={16} />
        </button>

        {visibleNotebooks.length > 1 && (
          <ul className="graph-legend">
            {visibleNotebooks.map((n) => (
              <li key={n.id}>
                <span className="notebook-dot" style={{ background: n.color ?? 'var(--accent)' }} />
                {n.title}
              </li>
            ))}
          </ul>
        )}

        {selected && (
          <div className="graph-card">
            <button className="icon-btn graph-card-close" aria-label="Close" onClick={() => setSelected(null)}>
              <X size={15} />
            </button>
            <span className="graph-card-title">{selected.label}</span>
            {selected.kind === 'page' && (
              <span className="muted graph-card-meta">
                {[notebookOf(selected.notebookId)?.title, ...ancestors(tree, selected.id).map((a) => displayTitle(a.title))].join(' › ')}
                {' · '}
                {selected.degree} {selected.degree === 1 ? 'connection' : 'connections'}
              </span>
            )}
            {selected.kind === 'page' && !!pages.data?.find((p) => p.id === selected.id)?.tags.length && (
              <span className="graph-card-tags">
                {pages.data!.find((p) => p.id === selected.id)!.tags.map((t) => (
                  <Link key={t} to={`/t/${encodeURIComponent(t)}`} className="tag-chip-link">
                    #{t}
                  </Link>
                ))}
              </span>
            )}
            {selected.kind === 'missing' && <span className="muted graph-card-meta">This page does not exist yet.</span>}
            <div className="graph-card-actions">
              <button className="btn btn-primary btn-sm" onClick={() => open(selected)}>
                {selected.kind === 'missing' ? (
                  <>
                    <FilePlus size={14} /> Create page
                  </>
                ) : (
                  <>
                    <ExternalLink size={14} /> Open
                  </>
                )}
              </button>
              {selected.kind === 'page' && selected.id !== focus && (
                <button className="btn btn-sm" onClick={() => setFocus(selected.id)}>
                  <Crosshair size={14} /> Focus
                </button>
              )}
            </div>
          </div>
        )}
        <p className="graph-hint muted">Click to select · double-click to open · drag to rearrange · scroll to zoom</p>
      </div>
    </div>
  );
}
