import { beforeEach, describe, expect, it } from 'vitest';
import { applyTemplate, type DailyEntry, type GraphLinks, type Notebook, type Page, type PageSummary, type Settings, type Tag } from '@nicotes/shared';
import { setup } from './helpers.js';

let api: ReturnType<typeof setup>;
let nb: Notebook;

beforeEach(async () => {
  api = setup();
  await api.call('POST', '/api/auth/setup', { username: 'nico', password: 'secret-pass' });
  nb = (await api.call<Notebook>('POST', '/api/notebooks', { title: 'Games' })).body;
});

const create = async (title: string, content = '', parentId: string | null = null) =>
  (await api.call<Page>('POST', '/api/pages', { notebookId: nb.id, parentId, title, content })).body;

describe('graph', () => {
  it('returns resolved links once, without self links, plus missing targets', async () => {
    const elden = await create('Elden Ring', 'See [[Elden Ring]] and [[Factorio]]');
    const factorio = await create('Factorio', 'Back to [[Elden Ring]], twice [[elden ring]], and [[Satisfactory]]');
    const graph = (await api.call<GraphLinks>('GET', '/api/graph')).body;
    expect(graph.links.sort((a, b) => a.source.localeCompare(b.source))).toEqual(
      [
        { source: elden.id, target: factorio.id },
        { source: factorio.id, target: elden.id },
      ].sort((a, b) => a.source.localeCompare(b.source)),
    );
    expect(graph.missing).toEqual([{ source: factorio.id, target: 'Satisfactory' }]);
  });
});

describe('tag inheritance', () => {
  it('lets #tag search match subpages when the tag inherits', async () => {
    const game = await create('Elden Ring', 'A game');
    const builds = await create('Builds', 'Strength build', game.id);
    await create('Deep', 'Strength deep dive', builds.id);
    await api.call('PUT', `/api/pages/${game.id}/tags`, { tags: ['gaming'] });

    const search = async (q: string) =>
      (await api.call<{ title: string }[]>('GET', `/api/search?q=${encodeURIComponent(q)}`)).body.map((r) => r.title).sort();
    expect(await search('#gaming')).toEqual(['Elden Ring']);
    expect(await search('#gaming strength')).toEqual([]);

    const updated = await api.call<Tag>('PATCH', '/api/tags/gaming', { inherit: true });
    expect(updated.body).toMatchObject({ name: 'gaming', inherit: true, count: 1 });
    expect(await search('#gaming')).toEqual(['Builds', 'Deep', 'Elden Ring']);
    expect(await search('#gaming strength')).toEqual(['Builds', 'Deep']);
  });
});

describe('daily notes', () => {
  it('creates notes under Journal / year / month once, and lists them by range', async () => {
    const first = await api.call<{ page: Page; created: boolean }>('POST', '/api/daily', {
      date: '2026-10-20',
      content: '## Notes\n\nSee [[Games]]',
      tags: ['daily', '#Journal'],
    });
    expect(first.body.created).toBe(true);
    expect(first.body.page).toMatchObject({ title: '2026-10-20', content: '## Notes\n\nSee [[Games]]', tags: ['daily', 'journal'] });

    const again = await api.call<{ page: Page; created: boolean }>('POST', '/api/daily', { date: '2026-10-20', content: 'ignored' });
    expect(again.body).toMatchObject({ created: false, page: { id: first.body.page.id, content: '## Notes\n\nSee [[Games]]' } });

    await api.call('POST', '/api/daily', { date: '2026-10-03' });
    await api.call('POST', '/api/daily', { date: '2026-09-30' });

    const notebooks = (await api.call<Notebook[]>('GET', '/api/notebooks')).body;
    const journal = notebooks.find((n) => n.title === 'Journal')!;
    const pages = (await api.call<PageSummary[]>('GET', '/api/pages')).body.filter((p) => p.notebookId === journal.id);
    const byId = new Map(pages.map((p) => [p.id, p]));
    const path = (p: PageSummary): string => (p.parentId ? `${path(byId.get(p.parentId)!)}/${p.title}` : p.title);
    expect(pages.map(path).sort()).toEqual(
      ['2026', '2026/October', '2026/September', '2026/October/2026-10-20', '2026/October/2026-10-03', '2026/September/2026-09-30'].sort(),
    );
    const october = pages.filter((p) => p.parentId === pages.find((x) => x.title === 'October')!.id);
    expect(october.sort((a, b) => a.sortOrder - b.sortOrder).map((p) => p.title)).toEqual(['2026-10-03', '2026-10-20']);

    const range = (await api.call<DailyEntry[]>('GET', '/api/daily?from=2026-10-01&to=2026-10-31')).body;
    expect(range.map((e) => e.date)).toEqual(['2026-10-03', '2026-10-20']);

    // A trashed daily note is replaced by a fresh one.
    await api.call('DELETE', `/api/pages/${first.body.page.id}`);
    const fresh = await api.call<{ page: Page; created: boolean }>('POST', '/api/daily', { date: '2026-10-20' });
    expect(fresh.body.created).toBe(true);
    expect(fresh.body.page.id).not.toBe(first.body.page.id);
    expect((await api.call('POST', '/api/daily', { date: '20.10.2026' })).status).toBe(400);
  });

  it('uses the configured notebook', async () => {
    await api.call<Settings>('PATCH', '/api/settings', { dailyNotebookId: nb.id });
    const res = await api.call<{ page: Page }>('POST', '/api/daily', { date: '2026-01-02' });
    expect(res.body.page.notebookId).toBe(nb.id);
    expect((await api.call<Settings>('GET', '/api/settings')).body.daily).toEqual({ notebookId: nb.id, templateId: null });
  });
});

describe('applyTemplate', () => {
  it('fills known placeholders and keeps unknown ones', () => {
    const vars = { date: '2026-10-20', time: '09:30', weekday: 'Tuesday', title: 'Plan' };
    expect(applyTemplate('# {{title}}\n{{ weekday }}, {{date}} {{TIME}} · {{datetime}} {{unknown}}', vars)).toBe(
      '# Plan\nTuesday, 2026-10-20 09:30 · 2026-10-20 09:30 {{unknown}}',
    );
  });
});
