import { beforeEach, describe, expect, it } from 'vitest';
import { MATCH_END, MATCH_START, type Notebook, type Page, type PageSummary, type Tag } from '@nicotes/shared';
import { setup } from './helpers.js';

type Hit = { id: string; title: string; excerpt: string };

describe('links, tags, search and attachments', () => {
  let api: ReturnType<typeof setup>;
  let games: Notebook;

  beforeEach(async () => {
    api = setup();
    await api.call('POST', '/api/auth/setup', { username: 'nico', password: 'secret-pass' });
    games = (await api.call<Notebook>('POST', '/api/notebooks', { title: 'Games' })).body;
  });

  const create = async (title: string, content = '', parentId: string | null = null, notebookId = games.id) =>
    (await api.call<Page>('POST', '/api/pages', { notebookId, parentId, title, content })).body;
  const get = async (id: string) => (await api.call<Page>('GET', `/api/pages/${id}`)).body;
  const backlinks = async (id: string) =>
    (await api.call<{ id: string; excerpt: string }[]>('GET', `/api/pages/${id}/backlinks`)).body;
  const search = async (q: string) => (await api.call<Hit[]>('GET', `/api/search?q=${encodeURIComponent(q)}`)).body;

  it('finds backlinks, including qualified and labelled links, but not links in code', async () => {
    const elden = await create('Elden Ring');
    const builds = await create('Builds', '', elden.id);
    const hub = await create('Hub', 'Play [[Elden Ring]] then\nsee [[Elden Ring/Builds|my builds]].');
    await create('Code', '`[[Elden Ring]]` is not a link');

    expect((await backlinks(elden.id)).map((b) => b.id)).toEqual([hub.id]);
    expect(await backlinks(builds.id)).toEqual([
      expect.objectContaining({ id: hub.id, excerpt: 'see [[Elden Ring/Builds|my builds]].' }),
    ]);
  });

  it('indexes links on content saves', async () => {
    const elden = await create('Elden Ring');
    const notes = await create('Notes');
    await api.call('PATCH', `/api/pages/${notes.id}`, { content: 'now [[elden ring]]', baseVersion: 1 });
    expect((await backlinks(elden.id)).map((b) => b.id)).toEqual([notes.id]);
    await api.call('PATCH', `/api/pages/${notes.id}`, { content: 'gone', baseVersion: 2 });
    expect(await backlinks(elden.id)).toEqual([]);
  });

  it('rewrites links when a page, its parent or its notebook is renamed, or a page moves', async () => {
    const elden = await create('Elden Ring');
    const builds = await create('Builds', '', elden.id);
    const hub = await create('Hub', '[[Elden Ring]], [[Elden Ring/Builds|b]], [[Games/Elden Ring]]');

    const renamed = await api.call<Page & { relinked: string[] }>('PATCH', `/api/pages/${elden.id}`, {
      title: 'Elden Ring 2',
    });
    expect(renamed.body.relinked).toEqual([hub.id]);
    expect((await get(hub.id)).content).toBe('[[Elden Ring 2]], [[Elden Ring 2/Builds|b]], [[Games/Elden Ring 2]]');
    expect((await get(hub.id)).version).toBe(2);

    await api.call('PATCH', `/api/notebooks/${games.id}`, { title: 'Spiele' });
    expect((await get(hub.id)).content).toBe('[[Elden Ring 2]], [[Elden Ring 2/Builds|b]], [[Spiele/Elden Ring 2]]');

    const factorio = await create('Factorio');
    await api.call('POST', `/api/pages/${builds.id}/move`, { notebookId: games.id, parentId: factorio.id, index: 0 });
    expect((await get(hub.id)).content).toContain('[[Factorio/Builds|b]]');
    expect((await backlinks(builds.id)).map((b) => b.id)).toEqual([hub.id]);
  });

  it('manages tags and drops unused ones without a description', async () => {
    const elden = await create('Elden Ring');
    const tagged = await api.call<Page>('PUT', `/api/pages/${elden.id}/tags`, {
      tags: ['#Gaming', 'Open World', 'gaming'],
    });
    expect(tagged.body.tags).toEqual(['gaming', 'open-world']);
    expect((await api.call<PageSummary[]>('GET', '/api/pages')).body[0]?.tags).toEqual(['gaming', 'open-world']);

    await api.call('PATCH', '/api/tags/gaming', { description: 'All my games' });
    await api.call('PUT', `/api/pages/${elden.id}/tags`, { tags: [] });
    expect((await api.call<Tag[]>('GET', '/api/tags')).body).toEqual([
      { name: 'gaming', description: 'All my games', color: null, count: 0 },
    ]);

    await api.call('PUT', `/api/pages/${elden.id}/tags`, { tags: ['gaming'] });
    expect((await api.call('PATCH', '/api/tags/gaming', { name: 'games' })).status).toBe(200);
    expect((await get(elden.id)).tags).toEqual(['games']);
  });

  it('searches content by prefix, ranks titles, filters by tag and hides deleted pages', async () => {
    const elden = await create('Elden Ring', 'Malenia is the hardest boss.');
    await create('Factorio', 'Build a main bus before trains.');
    await api.call('PUT', `/api/pages/${elden.id}/tags`, { tags: ['gaming'] });

    const hits = await search('male');
    expect(hits.map((h) => h.title)).toEqual(['Elden Ring']);
    expect(hits[0]?.excerpt).toContain(`${MATCH_START}Malenia${MATCH_END}`);

    expect((await search('elden'))[0]?.id).toBe(elden.id);
    expect((await search('#gaming')).map((h) => h.id)).toEqual([elden.id]);
    expect(await search('#gaming bus')).toEqual([]);
    // FTS syntax in user input is neutralised.
    expect((await api.call('GET', `/api/search?q=${encodeURIComponent('"OR NEAR( *')}`)).status).toBe(200);

    await api.call('DELETE', `/api/pages/${elden.id}`);
    expect(await search('malenia')).toEqual([]);
  });

  it('uploads attachments and serves them safely', async () => {
    const bytes = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
    const png = new File([bytes], 'map shot.png', { type: 'image/png' });
    expect((await api.upload(png, {})).status).toBe(415);

    const { status, body } = await api.upload(png);
    expect(status).toBe(201);
    expect(body.url).toMatch(/^\/api\/attachments\/[\w-]+\/map%20shot\.png$/);

    const res = await api.raw(body.url);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('content-disposition')).toMatch(/^inline/);
    expect(res.headers.get('content-security-policy')).toContain('sandbox');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);

    const html = new File(['<script>alert(1)</script>'], 'x.html', { type: 'text/html' });
    const htmlRes = await api.raw((await api.upload(html)).body.url);
    expect(htmlRes.headers.get('content-disposition')).toMatch(/^attachment/);
  });
});
