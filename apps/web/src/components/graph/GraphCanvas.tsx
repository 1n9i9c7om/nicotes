import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { forceCollide } from 'd3-force-3d';
import ForceGraph from 'force-graph';
import type { GraphEdge, GraphNode } from '../../lib/graph';

export interface GraphCanvasHandle {
  /** Pans/zooms to a node. */
  centerOn: (id: string) => void;
  fit: () => void;
}

interface Props {
  nodes: GraphNode[];
  links: GraphEdge[];
  selectedId?: string | null;
  focusId?: string | null;
  /** Nodes matching a search, drawn with a ring and a label. */
  matches?: Set<string>;
  onSelect?: (node: GraphNode | null) => void;
  /** Double-click (or single click when `clickOpens`). */
  onOpen?: (node: GraphNode) => void;
  clickOpens?: boolean;
  compact?: boolean;
}

type SimNode = GraphNode & { x?: number; y?: number; vx?: number; vy?: number };
type SimLink = Omit<GraphEdge, 'source' | 'target'> & { source: string | SimNode; target: string | SimNode };

const endId = (end: string | SimNode) => (typeof end === 'string' ? end : end.id);

function themeColors() {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  return {
    accent: v('--accent', '#22d3ee'),
    accent2: v('--accent-2', '#3b82f6'),
    text: v('--text', '#d6deeb'),
    faint: v('--text-faint', '#56647d'),
    edge: v('--border-strong', '#2a3852'),
    bg: v('--bg', '#0a0e16'),
    font: v('--font-sans', 'sans-serif'),
  };
}

const radius = (n: GraphNode) => (n.kind === 'page' ? 3 + Math.sqrt(n.degree) * 1.5 : n.kind === 'tag' ? 3.5 : 2.6);

/** Canvas graph built on force-graph (zoom, pan, drag, hover) with Nicotes styling. */
export const GraphCanvas = forwardRef<GraphCanvasHandle, Props>(function GraphCanvas(props, ref) {
  const host = useRef<HTMLDivElement>(null);
  const graph = useRef<ForceGraph<SimNode, SimLink> | null>(null);
  const latest = useRef(props);
  latest.current = props;
  const hover = useRef<string | null>(null);
  const neighbours = useRef(new Map<string, Set<string>>());
  const positions = useRef(new Map<string, { x: number; y: number }>());
  const fitted = useRef(false);
  const lastClick = useRef<{ id: string; at: number } | null>(null);

  /** force-graph only repaints on its own changes; re-centring in place forces one frame. */
  const repaint = () => {
    const g = graph.current;
    if (!g) return;
    const c = g.centerAt();
    g.centerAt(c.x, c.y);
  };

  useImperativeHandle(ref, () => ({
    centerOn: (id) => {
      const node = graph.current?.graphData().nodes.find((n) => n.id === id);
      if (node?.x === undefined || node.y === undefined) return;
      graph.current!.centerAt(node.x, node.y, 500);
      if (graph.current!.zoom() < 2.5) graph.current!.zoom(2.5, 500);
    },
    fit: () => graph.current?.zoomToFit(400, 40),
  }));

  // Create the graph once.
  useEffect(() => {
    const el = host.current!;
    const colors = themeColors();
    const active = () => hover.current ?? latest.current.selectedId ?? null;
    const isNear = (id: string) => {
      const a = active();
      return !a || a === id || !!neighbours.current.get(a)?.has(id);
    };

    const g = new ForceGraph<SimNode, SimLink>(el)
      .backgroundColor('rgba(0,0,0,0)')
      .nodeId('id')
      .cooldownTicks(latest.current.compact ? 120 : 250)
      // Fitting a tiny graph would otherwise zoom in until nodes are huge.
      .maxZoom(latest.current.compact ? 3 : 6)
      .d3VelocityDecay(0.3)
      .nodeCanvasObject((node, ctx, scale) => {
        const { selectedId, focusId, matches, compact, nodes } = latest.current;
        const x = node.x ?? 0;
        const y = node.y ?? 0;
        const r = radius(node);
        const near = isNear(node.id);
        ctx.globalAlpha = near ? 1 : 0.15;

        ctx.beginPath();
        if (node.kind === 'tag') {
          ctx.rect(x - r, y - r, r * 2, r * 2);
          ctx.fillStyle = colors.accent2;
          ctx.fill();
        } else if (node.kind === 'missing') {
          ctx.arc(x, y, r, 0, Math.PI * 2);
          ctx.setLineDash([1.5, 1.5]);
          ctx.lineWidth = 1 / Math.max(scale, 1) + 0.6;
          ctx.strokeStyle = colors.faint;
          ctx.stroke();
          ctx.setLineDash([]);
        } else {
          ctx.arc(x, y, r, 0, Math.PI * 2);
          ctx.fillStyle = node.color ?? colors.accent;
          ctx.fill();
        }

        const ring = node.id === selectedId || node.id === focusId || matches?.has(node.id);
        if (ring) {
          ctx.beginPath();
          ctx.arc(x, y, r + 2.5, 0, Math.PI * 2);
          ctx.lineWidth = 1.5;
          ctx.strokeStyle = matches?.has(node.id) && node.id !== selectedId ? colors.accent2 : colors.accent;
          ctx.stroke();
        }

        // Labels: when zoomed in, for the active neighbourhood, and for well-connected nodes.
        const labelAll = scale > 1.6 || (compact && nodes.length <= 30);
        const showLabel = labelAll || ring || (active() && near) || node.degree >= 6;
        if (showLabel) {
          // Constant on-screen size (graph units shrink as you zoom in).
          ctx.font = `${node.id === active() ? 600 : 400} ${12 / scale}px ${colors.font}`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'top';
          const label = node.label.length > 40 ? `${node.label.slice(0, 38)}…` : node.label;
          ctx.lineWidth = 3 / scale;
          ctx.strokeStyle = colors.bg;
          ctx.strokeText(label, x, y + r + 2);
          ctx.fillStyle = node.kind === 'missing' ? colors.faint : colors.text;
          ctx.fillText(label, x, y + r + 2);
        }
        ctx.globalAlpha = 1;
      })
      .nodePointerAreaPaint((node, color, ctx) => {
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(node.x ?? 0, node.y ?? 0, radius(node) + 3, 0, Math.PI * 2);
        ctx.fill();
      })
      .linkColor((link) => {
        const a = active();
        const s = endId(link.source);
        const t = endId(link.target);
        if (a && (s === a || t === a)) return colors.accent;
        if (a) return 'rgba(42, 56, 82, 0.25)';
        return link.kind === 'tag' ? 'rgba(59, 130, 246, 0.35)' : colors.edge;
      })
      .linkWidth((link) => {
        const a = active();
        return a && (endId(link.source) === a || endId(link.target) === a) ? 1.6 : 0.8;
      })
      .linkLineDash((link) => (link.kind === 'parent' ? [3, 2] : link.kind === 'tag' || link.kind === 'missing' ? [1, 2] : null))
      .linkDirectionalArrowLength((link) => (link.kind === 'link' ? 3.5 : 0))
      .linkDirectionalArrowRelPos(0.92)
      .onNodeHover((node) => {
        hover.current = node?.id ?? null;
        el.style.cursor = node ? 'pointer' : '';
        repaint();
      })
      .onNodeClick((node) => {
        const { clickOpens, onOpen, onSelect } = latest.current;
        if (clickOpens) return onOpen?.(node);
        const now = Date.now();
        if (lastClick.current?.id === node.id && now - lastClick.current.at < 350) {
          lastClick.current = null;
          return onOpen?.(node);
        }
        lastClick.current = { id: node.id, at: now };
        onSelect?.(node);
      })
      .onBackgroundClick(() => latest.current.onSelect?.(null))
      .onEngineStop(() => {
        for (const n of g.graphData().nodes) if (n.x !== undefined && n.y !== undefined) positions.current.set(n.id, { x: n.x, y: n.y });
        if (!fitted.current) {
          fitted.current = true;
          g.zoomToFit(400, latest.current.compact ? 24 : 60);
        }
      });

    g.d3Force('charge')?.strength?.(latest.current.compact ? -80 : -130);
    (g.d3Force('link') as { distance?: (fn: (l: SimLink) => number) => void } | undefined)?.distance?.((l) =>
      l.kind === 'parent' ? 34 : l.kind === 'tag' ? 40 : 55,
    );
    // Gentle pull to the centre so unlinked pages and separate clusters stay in view.
    let simNodes: SimNode[] = [];
    const gravity = Object.assign(
      (alpha: number) => {
        for (const n of simNodes) {
          n.vx = (n.vx ?? 0) - (n.x ?? 0) * 0.12 * alpha;
          n.vy = (n.vy ?? 0) - (n.y ?? 0) * 0.12 * alpha;
        }
      },
      { initialize: (nodes: SimNode[]) => (simNodes = nodes) },
    );
    g.d3Force('gravity', gravity as never);
    // Keep nodes (and roughly their labels) from overlapping.
    g.d3Force('collide', forceCollide<SimNode>((n) => radius(n) + 9).strength(0.9) as never);
    graph.current = g;

    const resize = new ResizeObserver(() => g.width(el.clientWidth).height(el.clientHeight));
    resize.observe(el);
    return () => {
      resize.disconnect();
      g._destructor();
      graph.current = null;
    };
  }, []);

  // New data: keep known positions so toggling filters doesn't reshuffle the layout.
  useEffect(() => {
    const g = graph.current;
    if (!g) return;
    for (const n of g.graphData().nodes) if (n.x !== undefined && n.y !== undefined) positions.current.set(n.id, { x: n.x, y: n.y });
    const map = new Map<string, Set<string>>();
    for (const l of props.links) {
      if (!map.has(l.source)) map.set(l.source, new Set());
      if (!map.has(l.target)) map.set(l.target, new Set());
      map.get(l.source)!.add(l.target);
      map.get(l.target)!.add(l.source);
    }
    neighbours.current = map;
    const nodes: SimNode[] = props.nodes.map((n) => ({ ...n, ...positions.current.get(n.id) }));
    const links: SimLink[] = props.links.map((l) => ({ ...l }));
    if (!positions.current.size) fitted.current = false;
    g.graphData({ nodes, links });
  }, [props.nodes, props.links]);

  // Selection, focus or search changes only need a repaint.
  useEffect(repaint, [props.selectedId, props.focusId, props.matches]);

  // Refit when the focus changes (a different neighbourhood).
  useEffect(() => {
    fitted.current = false;
  }, [props.focusId]);

  return <div ref={host} className="graph-canvas" />;
});

export default GraphCanvas;
