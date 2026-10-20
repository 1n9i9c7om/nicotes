import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Notebook, Page, PageSummary } from '@nicotes/shared';
import { createApp } from '../src/app.js';
import { openDb } from '../src/db/index.js';

const migrationsFolder = fileURLToPath(new URL('../drizzle', import.meta.url));

function setup() {
  const db = openDb(':memory:', migrationsFolder);
  const app = createApp({ db, secureCookies: false });
  let cookie = '';

  async function call<T = unknown>(method: string, path: string, body?: unknown) {
    const res = await app.request(path, {
      method,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(cookie ? { cookie } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0]!;
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
  }

  return { call, logout: () => (cookie = '') };
}

describe('auth', () => {
  it('requires setup, then signs in and out', async () => {
    const { call, logout } = setup();
    expect((await call('GET', '/api/auth/status')).body).toEqual({ user: null, setupRequired: true });
    expect((await call('GET', '/api/notebooks')).status).toBe(401);

    const created = await call('POST', '/api/auth/setup', { username: 'Nico', password: 'secret-pass' });
    expect(created.status).toBe(201);
    expect((await call('GET', '/api/auth/status')).body).toMatchObject({
      user: { username: 'nico' },
      setupRequired: false,
    });

    expect((await call('POST', '/api/auth/setup', { username: 'x', password: 'another-pass' })).status).toBe(403);

    await call('POST', '/api/auth/logout');
    logout();
    expect((await call('GET', '/api/notebooks')).status).toBe(401);
    expect((await call('POST', '/api/auth/login', { username: 'nico', password: 'wrong-pass' })).status).toBe(401);
    expect((await call('POST', '/api/auth/login', { username: 'NICO', password: 'secret-pass' })).status).toBe(200);
    expect((await call('GET', '/api/notebooks')).status).toBe(200);
  });

  it('rejects non-JSON mutations (CSRF guard)', async () => {
    const app = createApp({ db: openDb(':memory:', migrationsFolder), secureCookies: false });
    const res = await app.request('/api/auth/setup', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'username=evil&password=evil-pass',
    });
    expect(res.status).toBe(415);
  });
});

describe('notebooks and pages', () => {
  let api: ReturnType<typeof setup>['call'];
  let notebook: Notebook;

  beforeEach(async () => {
    api = setup().call;
    await api('POST', '/api/auth/setup', { username: 'nico', password: 'secret-pass' });
    notebook = (await api<Notebook>('POST', '/api/notebooks', { title: 'Games' })).body;
  });

  const tree = async () => (await api<PageSummary[]>('GET', '/api/pages')).body;
  const createPage = async (title: string, parentId: string | null = null, notebookId = notebook.id) =>
    (await api<Page>('POST', '/api/pages', { notebookId, parentId, title })).body;

  it('creates nested pages in order', async () => {
    const game = await createPage('Elden Ring');
    const builds = await createPage('Builds', game.id);
    const bosses = await createPage('Bosses', game.id);
    expect(builds.sortOrder).toBe(0);
    expect(bosses.sortOrder).toBe(1);
    expect((await tree()).map((p) => [p.title, p.parentId])).toEqual([
      ['Elden Ring', null],
      ['Builds', game.id],
      ['Bosses', game.id],
    ]);
  });

  it('saves content with optimistic concurrency', async () => {
    const page = await createPage('Notes');
    const saved = await api<Page>('PATCH', `/api/pages/${page.id}`, { content: '# Hi', baseVersion: 1 });
    expect(saved.body).toMatchObject({ content: '# Hi', version: 2 });

    const stale = await api<{ current: Page }>('PATCH', `/api/pages/${page.id}`, {
      content: 'stale',
      baseVersion: 1,
    });
    expect(stale.status).toBe(409);
    expect(stale.body.current.content).toBe('# Hi');

    // Title-only changes do not bump the content version.
    const renamed = await api<Page>('PATCH', `/api/pages/${page.id}`, { title: 'Renamed' });
    expect(renamed.body).toMatchObject({ title: 'Renamed', version: 2 });
    expect((await api('PATCH', `/api/pages/${page.id}`, { content: 'x' })).status).toBe(400);
  });

  it('moves pages, reorders siblings and prevents cycles', async () => {
    const a = await createPage('A');
    const b = await createPage('B');
    const child = await createPage('A.1', a.id);

    await api('POST', `/api/pages/${b.id}/move`, { notebookId: notebook.id, parentId: null, index: 0 });
    expect((await tree()).filter((p) => !p.parentId).map((p) => p.title)).toEqual(['B', 'A']);

    const cycle = await api('POST', `/api/pages/${a.id}/move`, {
      notebookId: notebook.id,
      parentId: child.id,
      index: 0,
    });
    expect(cycle.status).toBe(400);

    const other = (await api<Notebook>('POST', '/api/notebooks', { title: 'Other' })).body;
    await api('POST', `/api/pages/${a.id}/move`, { notebookId: other.id, parentId: null, index: 0 });
    const moved = await tree();
    expect(moved.find((p) => p.id === a.id)?.notebookId).toBe(other.id);
    expect(moved.find((p) => p.id === child.id)?.notebookId).toBe(other.id);
  });

  it('soft-deletes a page with its subtree, and notebooks with their pages', async () => {
    const a = await createPage('A');
    await createPage('A.1', a.id);
    const b = await createPage('B');
    expect((await api('DELETE', `/api/pages/${a.id}`)).status).toBe(204);
    expect((await tree()).map((p) => p.title)).toEqual(['B']);
    expect((await api('GET', `/api/pages/${a.id}`)).status).toBe(404);

    await api('DELETE', `/api/notebooks/${notebook.id}`);
    expect(await tree()).toEqual([]);
    expect((await api('GET', `/api/pages/${b.id}`)).status).toBe(404);
  });

  it('reorders notebooks', async () => {
    const second = (await api<Notebook>('POST', '/api/notebooks', { title: 'Recipes' })).body;
    await api('POST', `/api/notebooks/${second.id}/move`, { index: 0 });
    const list = (await api<Notebook[]>('GET', '/api/notebooks')).body;
    expect(list.map((n) => n.title)).toEqual(['Recipes', 'Games']);
  });
});
