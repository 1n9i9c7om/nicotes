import { strFromU8, unzipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Notebook, Page, PageSummary, PageVersion, PageVersionSummary, TrashItem } from '@nicotes/shared';
import { safeFileName } from '../src/routes/export.js';
import { purgeTrash } from '../src/routes/trash.js';
import { versionsToKeep } from '../src/versions.js';
import { setup } from './helpers.js';

const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;

describe('version retention', () => {
  it('keeps the last day, then one per day for 90 days, at most 200', () => {
    const now = Date.UTC(2026, 9, 20, 12);
    const rows = [
      { id: 'recent-1', createdAt: now - 5 * MIN },
      { id: 'recent-2', createdAt: now - 20 * 60 * MIN },
      { id: 'day2-late', createdAt: Date.UTC(2026, 9, 18, 20) },
      { id: 'day2-early', createdAt: Date.UTC(2026, 9, 18, 8) },
      { id: 'old', createdAt: now - 100 * DAY },
    ];
    expect([...versionsToKeep(rows, now)]).toEqual(['recent-1', 'recent-2', 'day2-late']);

    const many = Array.from({ length: 250 }, (_, i) => ({ id: `v${i}`, createdAt: now - i * MIN }));
    expect(versionsToKeep(many, now).size).toBe(200);
  });
});

describe('page history', () => {
  let api: ReturnType<typeof setup>;
  let nb: Notebook;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.UTC(2026, 9, 20, 12));
    api = setup();
    await api.call('POST', '/api/auth/setup', { username: 'nico', password: 'secret-pass' });
    nb = (await api.call<Notebook>('POST', '/api/notebooks', { title: 'Games' })).body;
  });
  afterEach(() => vi.useRealTimers());

  const save = async (id: string, content: string) => {
    const page = (await api.call<Page>('GET', `/api/pages/${id}`)).body;
    return api.call<Page>('PATCH', `/api/pages/${id}`, { content, baseVersion: page.version });
  };
  const versions = async (id: string) => (await api.call<PageVersionSummary[]>('GET', `/api/pages/${id}/versions`)).body;

  it('snapshots at most every 10 minutes while editing, and restores content', async () => {
    const page = (await api.call<Page>('POST', '/api/pages', { notebookId: nb.id, title: 'Plan', content: 'v1' })).body;
    await save(page.id, 'v2'); // snapshot of "v1"
    await save(page.id, 'v3'); // too soon
    expect((await versions(page.id)).map((v) => v.reason)).toEqual(['edit']);

    vi.advanceTimersByTime(11 * MIN);
    await save(page.id, 'v4'); // snapshot of "v3"
    const list = await versions(page.id);
    expect(list).toHaveLength(2);
    const oldest = (await api.call<PageVersion>('GET', `/api/pages/${page.id}/versions/${list[1]!.id}`)).body;
    expect(oldest.content).toBe('v1');

    const restored = await api.call<Page>('POST', `/api/pages/${page.id}/versions/${oldest.id}/restore`);
    expect(restored.body.content).toBe('v1');
    const after = await versions(page.id);
    expect(after[0]).toMatchObject({ reason: 'restore', size: 2 });
    const undo = (await api.call<PageVersion>('GET', `/api/pages/${page.id}/versions/${after[0]!.id}`)).body;
    expect(undo.content).toBe('v4');
  });

  it('snapshots pages before rewriting their links', async () => {
    const target = (await api.call<Page>('POST', '/api/pages', { notebookId: nb.id, title: 'Elden Ring' })).body;
    const hub = (await api.call<Page>('POST', '/api/pages', { notebookId: nb.id, title: 'Hub', content: 'See [[Elden Ring]]' }))
      .body;
    await api.call('PATCH', `/api/pages/${target.id}`, { title: 'Elden Ring 2' });
    const list = await versions(hub.id);
    expect(list.map((v) => v.reason)).toEqual(['relink']);
    const v = (await api.call<PageVersion>('GET', `/api/pages/${hub.id}/versions/${list[0]!.id}`)).body;
    expect(v.content).toBe('See [[Elden Ring]]');
  });
});

describe('trash', () => {
  let api: ReturnType<typeof setup>;
  let nb: Notebook;

  beforeEach(async () => {
    api = setup();
    await api.call('POST', '/api/auth/setup', { username: 'nico', password: 'secret-pass' });
    nb = (await api.call<Notebook>('POST', '/api/notebooks', { title: 'Games' })).body;
  });

  const create = async (title: string, parentId: string | null = null, notebookId = nb.id) =>
    (await api.call<Page>('POST', '/api/pages', { notebookId, parentId, title })).body;
  const trash = async () => (await api.call<TrashItem[]>('GET', '/api/trash')).body;
  const live = async () => (await api.call<PageSummary[]>('GET', '/api/pages')).body;

  it('lists deleted subtrees as one item and restores them', async () => {
    const game = await create('Elden Ring');
    const builds = await create('Builds', game.id);
    await create('Boss notes', builds.id);
    await api.call('DELETE', `/api/pages/${builds.id}`);

    expect(await trash()).toEqual([expect.objectContaining({ kind: 'page', id: builds.id, pageCount: 2, notebookTitle: 'Games' })]);
    await api.call('POST', '/api/trash/restore', { kind: 'page', id: builds.id });
    expect(await trash()).toEqual([]);
    expect((await live()).find((p) => p.id === builds.id)?.parentId).toBe(game.id);
    expect(await live()).toHaveLength(3);
  });

  it('restores to the top level when the old parent is gone', async () => {
    const game = await create('Elden Ring');
    const builds = await create('Builds', game.id);
    await api.call('DELETE', `/api/pages/${builds.id}`);
    await api.call('DELETE', `/api/pages/${game.id}`);
    expect((await trash()).map((i) => i.title)).toEqual(['Elden Ring', 'Builds']);

    await api.call('POST', '/api/trash/restore', { kind: 'page', id: builds.id });
    expect((await live()).map((p) => [p.title, p.parentId])).toEqual([['Builds', null]]);
  });

  it('keeps deletions within the same millisecond apart', async () => {
    const game = await create('Elden Ring');
    const builds = await create('Builds', game.id);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.UTC(2026, 9, 20, 12));
    try {
      await api.call('DELETE', `/api/pages/${builds.id}`);
      await api.call('DELETE', `/api/pages/${game.id}`);
    } finally {
      vi.useRealTimers();
    }
    expect((await trash()).map((i) => [i.title, i.pageCount])).toEqual([
      ['Elden Ring', 1],
      ['Builds', 1],
    ]);
  });

  it('restores notebooks with the pages deleted alongside them', async () => {
    await create('Elden Ring');
    await api.call('DELETE', `/api/notebooks/${nb.id}`);
    expect(await trash()).toEqual([expect.objectContaining({ kind: 'notebook', pageCount: 1 })]);
    await api.call('POST', '/api/trash/restore', { kind: 'notebook', id: nb.id });
    expect((await api.call<Notebook[]>('GET', '/api/notebooks')).body).toHaveLength(1);
    expect(await live()).toHaveLength(1);
  });

  it('deletes permanently, empties and purges after 30 days', async () => {
    const a = await create('A');
    const b = await create('B');
    const c = await create('C');
    for (const p of [a, b, c]) await api.call('DELETE', `/api/pages/${p.id}`);

    expect((await api.call('DELETE', `/api/trash/page/${a.id}`)).status).toBe(204);
    expect((await trash()).map((i) => i.title).sort()).toEqual(['B', 'C']);
    expect((await api.call('DELETE', `/api/trash/page/${a.id}`)).status).toBe(404);

    purgeTrash(api.db, Date.now() + 31 * DAY);
    expect(await trash()).toEqual([]);

    const d = await create('D');
    await api.call('DELETE', `/api/pages/${d.id}`);
    await api.call('DELETE', '/api/trash');
    expect(await trash()).toEqual([]);
  });
});

describe('export', () => {
  it('writes an Obsidian-style zip with frontmatter and attachments', async () => {
    const api = setup();
    await api.call('POST', '/api/auth/setup', { username: 'nico', password: 'secret-pass' });
    const nb = (await api.call<Notebook>('POST', '/api/notebooks', { title: 'Games: PC' })).body;
    const png = new File([new Uint8Array([1, 2, 3])], 'map shot.png', { type: 'image/png' });
    const att = (await api.upload(png)).body;
    const game = (
      await api.call<Page>('POST', '/api/pages', {
        notebookId: nb.id,
        title: 'Elden Ring',
        content: `![map](${att.url})\n\nSee [[Builds]]`,
      })
    ).body;
    await api.call('PUT', `/api/pages/${game.id}/tags`, { tags: ['gaming'] });
    await api.call('POST', '/api/pages', { notebookId: nb.id, parentId: game.id, title: 'Builds' });
    await api.call('POST', '/api/pages', { notebookId: nb.id, title: 'Elden Ring' });

    const res = await api.raw('/api/export');
    expect(res.headers.get('content-type')).toBe('application/zip');
    expect(res.headers.get('content-disposition')).toMatch(/nicotes-\d{4}-\d{2}-\d{2}\.zip/);
    const files = unzipSync(new Uint8Array(await res.arrayBuffer()));
    const attPath = Object.keys(files).find((p) => p.startsWith('attachments/'))!;
    expect(Object.keys(files).sort()).toEqual(
      [attPath, 'Games- PC/Elden Ring.md', 'Games- PC/Elden Ring (2).md', 'Games- PC/Elden Ring/Builds.md'].sort(),
    );
    expect(attPath).toMatch(/^attachments\/[\w-]+-map shot\.png$/);
    expect(files[attPath]).toEqual(new Uint8Array([1, 2, 3]));

    const md = strFromU8(files['Games- PC/Elden Ring.md']!);
    expect(md).toMatch(/^---\nid: "[\w-]+"\ntitle: "Elden Ring"\ntags: \["gaming"\]\ncreated: "\d{4}-/);
    expect(md).toContain(`![map](../${encodeURI(attPath)})`);
    expect(md).toContain('See [[Builds]]');
    expect(safeFileName('CON')).toBe('CON_');
    expect(safeFileName('a/b: c?. ')).toBe('a-b- c-');
  });
});
