import { describe, expect, it } from 'vitest';
import type { Notebook, PageSummary, Tag } from '@nicotes/shared';
import { buildGraph, DEFAULT_GRAPH_OPTIONS, type GraphInput } from './graph';
import { inheritedTagMap } from './tags';

const page = (id: string, notebookId: string, parentId: string | null = null, tags: string[] = []): PageSummary => ({
  id,
  notebookId,
  parentId,
  title: id,
  sortOrder: 0,
  tags,
  canvas: false,
  createdAt: 0,
  updatedAt: 0,
});
const nb = (id: string, color: string): Notebook => ({ id, title: id, icon: null, color, sortOrder: 0, createdAt: 0, updatedAt: 0 });
const tag = (name: string, inherit = false): Tag => ({ name, description: '', color: null, inherit, count: 1 });

const input: GraphInput = {
  notebooks: [nb('games', '#a78bfa'), nb('food', '#4ade80')],
  pages: [
    page('elden', 'games', null, ['gaming']),
    page('builds', 'games', 'elden'),
    page('factorio', 'games', null, ['gaming']),
    page('cookies', 'food', null, ['recipe']),
    page('lonely', 'games'),
  ],
  tags: [tag('gaming', true), tag('recipe')],
  links: {
    links: [
      { source: 'elden', target: 'factorio' },
      { source: 'cookies', target: 'elden' },
    ],
    missing: [{ source: 'factorio', target: 'Satisfactory' }],
  },
};

const ids = (g: ReturnType<typeof buildGraph>) => g.nodes.map((n) => n.id).sort();

describe('buildGraph', () => {
  it('includes links and hierarchy, sizes nodes by degree and colours them by notebook', () => {
    const g = buildGraph(input, DEFAULT_GRAPH_OPTIONS);
    expect(ids(g)).toEqual(['builds', 'cookies', 'elden', 'factorio', 'lonely']);
    expect(g.links).toHaveLength(3);
    expect(g.nodes.find((n) => n.id === 'elden')).toMatchObject({ degree: 3, color: '#a78bfa' });
  });

  it('filters by notebook, by (inherited) tag and drops orphans on request', () => {
    expect(ids(buildGraph(input, { ...DEFAULT_GRAPH_OPTIONS, notebookId: 'food' }))).toEqual(['cookies']);
    // "builds" inherits #gaming from "elden".
    expect(ids(buildGraph(input, { ...DEFAULT_GRAPH_OPTIONS, tag: 'gaming' }))).toEqual(['builds', 'elden', 'factorio']);
    expect(ids(buildGraph(input, { ...DEFAULT_GRAPH_OPTIONS, orphans: false }))).not.toContain('lonely');
  });

  it('adds tag and missing nodes when enabled', () => {
    const g = buildGraph(input, { ...DEFAULT_GRAPH_OPTIONS, tags: true, missing: true });
    expect(ids(g)).toEqual(expect.arrayContaining(['tag:gaming', 'tag:recipe', 'missing:satisfactory']));
    expect(g.nodes.find((n) => n.id === 'tag:gaming')).toMatchObject({ kind: 'tag', label: '#gaming', degree: 2 });
  });

  it('leaves template pages out', () => {
    const withTemplate = { ...input, pages: [...input.pages, page('tpl', 'games', null, ['template', 'gaming'])] };
    expect(ids(buildGraph(withTemplate, DEFAULT_GRAPH_OPTIONS))).not.toContain('tpl');
    expect(ids(buildGraph(withTemplate, { ...DEFAULT_GRAPH_OPTIONS, tag: 'gaming' }))).not.toContain('tpl');
  });

  it('shows the neighbourhood of a focused page across notebooks', () => {
    const one = buildGraph(input, { ...DEFAULT_GRAPH_OPTIONS, notebookId: 'games', focus: 'factorio', depth: 1 });
    expect(ids(one)).toEqual(['elden', 'factorio']);
    const two = buildGraph(input, { ...DEFAULT_GRAPH_OPTIONS, focus: 'factorio', depth: 2 });
    expect(ids(two)).toEqual(['builds', 'cookies', 'elden', 'factorio']);
  });
});

describe('inheritedTagMap', () => {
  it('passes inheriting tags down to all descendants', () => {
    const pages = [page('a', 'n', null, ['gaming', 'recipe']), page('b', 'n', 'a'), page('c', 'n', 'b', ['gaming'])];
    const map = inheritedTagMap(pages, [tag('gaming', true), tag('recipe')]);
    expect(map.get('b')).toEqual([{ name: 'gaming', fromId: 'a' }]);
    expect(map.has('c')).toBe(false); // carries the tag itself
    expect(map.has('a')).toBe(false);
  });
});
