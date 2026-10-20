import { lazy, Suspense, useMemo } from 'react';
import { Link, useNavigate } from 'react-router';
import { ChevronRight, Maximize2, Waypoints } from 'lucide-react';
import { buildGraph, DEFAULT_GRAPH_OPTIONS, type GraphNode } from '../../lib/graph';
import { useOpenWikilink } from '../../lib/links';
import { useGraphLinks, useNotebooks, usePages, useTags } from '../../lib/queries';
import { useLocalState } from '../../lib/storage';

const GraphCanvas = lazy(() => import('./GraphCanvas'));

/** Collapsible neighbourhood graph under a page; clicking a node opens it. */
export function LocalGraph({ pageId, notebookId }: { pageId: string; notebookId: string }) {
  const [open, setOpen] = useLocalState('nicotes.localGraphOpen', true);
  const [depth, setDepth] = useLocalState('nicotes.localGraphDepth', 1);
  const navigate = useNavigate();
  const openLink = useOpenWikilink(notebookId);
  const pages = usePages();
  const notebooks = useNotebooks();
  const tags = useTags();
  const links = useGraphLinks();

  const ready = pages.data && notebooks.data && tags.data && links.data;
  const data = useMemo(
    () =>
      ready
        ? buildGraph(
            { pages: pages.data!, notebooks: notebooks.data!, tags: tags.data!, links: links.data! },
            { ...DEFAULT_GRAPH_OPTIONS, focus: pageId, depth, missing: true },
          )
        : null,
    [ready, pages.data, notebooks.data, tags.data, links.data, pageId, depth],
  );

  const openNode = (node: GraphNode) => {
    if (node.kind === 'page') navigate(`/p/${node.id}`);
    else if (node.kind === 'tag') navigate(`/t/${encodeURIComponent(node.label.slice(1))}`);
    else if (node.target) void openLink(node.target);
  };

  const connections = (data?.nodes.length ?? 1) - 1;

  return (
    <section className="local-graph" aria-label="Local graph">
      <div className="local-graph-head">
        <button className="backlinks-header" aria-expanded={open} onClick={() => setOpen(!open)}>
          <ChevronRight size={14} className={open ? 'tree-toggle open' : 'tree-toggle'} />
          <Waypoints size={14} />
          Graph{data ? ` · ${connections} ${connections === 1 ? 'neighbour' : 'neighbours'}` : ''}
        </button>
        {open && (
          <>
            <div className="segmented" role="group" aria-label="Depth">
              {[1, 2].map((d) => (
                <button key={d} className={d === depth ? 'active' : ''} onClick={() => setDepth(d)}>
                  {d} {d === 1 ? 'hop' : 'hops'}
                </button>
              ))}
            </div>
            <Link className="icon-btn" to={`/graph?focus=${pageId}&depth=${Math.max(depth, 2)}`} aria-label="Open in graph view" title="Open in graph view">
              <Maximize2 size={15} />
            </Link>
          </>
        )}
      </div>
      {open && data && (
        <div className="local-graph-stage">
          {connections === 0 ? (
            <p className="muted local-graph-empty">No connections yet. Link other pages with [[…]] or add subpages.</p>
          ) : (
            <Suspense fallback={null}>
              <GraphCanvas nodes={data.nodes} links={data.links} focusId={pageId} clickOpens compact onOpen={openNode} />
            </Suspense>
          )}
        </div>
      )}
    </section>
  );
}
