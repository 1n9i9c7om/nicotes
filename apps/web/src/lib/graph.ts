import { TEMPLATE_TAG, type GraphLinks, type Notebook, type PageSummary, type Tag } from '@nicotes/shared';
import { effectiveTags, inheritedTagMap } from './tags';
import { displayTitle } from './tree';

export type NodeKind = 'page' | 'tag' | 'missing';
export type EdgeKind = 'link' | 'parent' | 'tag' | 'missing';

export interface GraphNode {
  id: string;
  kind: NodeKind;
  label: string;
  /** Notebook colour for pages. */
  color: string | null;
  notebookId: string | null;
  /** Unresolved link target (missing nodes). */
  target?: string;
  degree: number;
  // Positions are filled in by the force simulation.
  x?: number;
  y?: number;
}

export interface GraphEdge {
  source: string;
  target: string;
  kind: EdgeKind;
}

export interface GraphOptions {
  /** Restrict to one notebook (ignored in focus mode). */
  notebookId: string | null;
  /** Only pages carrying this tag, inherited tags included (ignored in focus mode). */
  tag: string | null;
  links: boolean;
  hierarchy: boolean;
  tags: boolean;
  orphans: boolean;
  missing: boolean;
  /** Show only the neighbourhood of this page… */
  focus: string | null;
  /** …up to this many hops. */
  depth: number;
}

export const DEFAULT_GRAPH_OPTIONS: GraphOptions = {
  notebookId: null,
  tag: null,
  links: true,
  hierarchy: true,
  tags: false,
  orphans: true,
  missing: false,
  focus: null,
  depth: 2,
};

export interface GraphInput {
  pages: PageSummary[];
  notebooks: Notebook[];
  tags: Tag[];
  links: GraphLinks;
}

export const tagNodeId = (tag: string) => `tag:${tag}`;
export const missingNodeId = (target: string) => `missing:${target.trim().toLowerCase()}`;

/** Builds nodes and edges for the graph view from pages, tags and resolved links. */
export function buildGraph(input: GraphInput, opt: GraphOptions): { nodes: GraphNode[]; links: GraphEdge[] } {
  const colors = new Map(input.notebooks.map((n) => [n.id, n.color]));
  const inherited = inheritedTagMap(input.pages, input.tags);
  const focusing = !!opt.focus && input.pages.some((p) => p.id === opt.focus && !p.tags.includes(TEMPLATE_TAG));

  // Templates are scaffolding, not knowledge. In focus mode everything else is a candidate:
  // neighbourhoods cross notebooks.
  const content = input.pages.filter((p) => !p.tags.includes(TEMPLATE_TAG));
  const pages = focusing
    ? content
    : content.filter(
        (p) =>
          (!opt.notebookId || p.notebookId === opt.notebookId) &&
          (!opt.tag || effectiveTags(p, inherited).includes(opt.tag)),
      );
  const inSet = new Set(pages.map((p) => p.id));

  const nodes = new Map<string, GraphNode>();
  for (const p of pages) {
    nodes.set(p.id, {
      id: p.id,
      kind: 'page',
      label: displayTitle(p.title),
      color: colors.get(p.notebookId) ?? null,
      notebookId: p.notebookId,
      degree: 0,
    });
  }
  const edges: GraphEdge[] = [];
  const seen = new Set<string>();
  const addEdge = (source: string, target: string, kind: EdgeKind) => {
    const key = kind === 'link' ? `${source}>${target}` : [source, target].sort().join('|') + kind;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push({ source, target, kind });
  };

  if (opt.links) {
    for (const l of input.links.links) if (inSet.has(l.source) && inSet.has(l.target)) addEdge(l.source, l.target, 'link');
  }
  if (opt.hierarchy) {
    for (const p of pages) if (p.parentId && inSet.has(p.parentId)) addEdge(p.parentId, p.id, 'parent');
  }
  if (opt.tags) {
    for (const p of pages) {
      for (const tag of p.tags) {
        const id = tagNodeId(tag);
        if (!nodes.has(id)) nodes.set(id, { id, kind: 'tag', label: `#${tag}`, color: null, notebookId: null, degree: 0 });
        addEdge(p.id, id, 'tag');
      }
    }
  }
  if (opt.missing) {
    for (const m of input.links.missing) {
      if (!inSet.has(m.source)) continue;
      const id = missingNodeId(m.target);
      if (!nodes.has(id)) nodes.set(id, { id, kind: 'missing', label: m.target, color: null, notebookId: null, target: m.target, degree: 0 });
      addEdge(m.source, id, 'missing');
    }
  }

  let keep: Set<string> | null = null;
  if (focusing) {
    // Breadth-first over all visible edge kinds, ignoring direction.
    const adjacency = new Map<string, string[]>();
    for (const e of edges) {
      adjacency.set(e.source, [...(adjacency.get(e.source) ?? []), e.target]);
      adjacency.set(e.target, [...(adjacency.get(e.target) ?? []), e.source]);
    }
    keep = new Set([opt.focus!]);
    let frontier = [opt.focus!];
    for (let hop = 0; hop < opt.depth && frontier.length; hop++) {
      const next: string[] = [];
      for (const id of frontier) for (const n of adjacency.get(id) ?? []) if (!keep.has(n)) (keep.add(n), next.push(n));
      frontier = next;
    }
  }

  const finalEdges = keep ? edges.filter((e) => keep!.has(e.source) && keep!.has(e.target)) : edges;
  for (const e of finalEdges) {
    nodes.get(e.source)!.degree++;
    nodes.get(e.target)!.degree++;
  }
  const finalNodes = [...nodes.values()].filter(
    (n) => (!keep || keep.has(n.id)) && (n.kind !== 'page' || n.degree > 0 || opt.orphans || n.id === opt.focus),
  );
  return { nodes: finalNodes, links: finalEdges };
}
