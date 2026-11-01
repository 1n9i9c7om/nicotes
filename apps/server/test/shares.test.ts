import { describe, expect, it } from 'vitest';
import type { Notebook, Page, PublicShare, Share } from '@nicotes/shared';
import { setup } from './helpers.js';

async function withPages() {
  const api = setup();
  await api.call('POST', '/api/auth/setup', { username: 'nico', password: 'secret-pass' });
  const nb = (await api.call<Notebook>('POST', '/api/notebooks', { title: 'Travel' })).body;
  const page = async (title: string, content = '', parentId: string | null = null) =>
    (await api.call<Page>('POST', '/api/pages', { notebookId: nb.id, title, content, parentId })).body;
  const photo = (await api.upload(new File([Buffer.from('fake-png')], 'beach.png', { type: 'image/png' }))).body;
  const secret = (await api.upload(new File([Buffer.from('secret')], 'secret.png', { type: 'image/png' }))).body;
  const lisbon = await page('Lisbon', `Sunny. See [[Porto]].\n\n![beach](${photo.url})`);
  const porto = await page('Porto', 'Port wine.', lisbon.id);
  const diary = await page('Diary', `Private! ![x](${secret.url})`);
  return { api, nb, lisbon, porto, diary, photo, secret };
}

const tokenOf = (share: Share) => share.path!.replace('/s/', '');
const open = (api: ReturnType<typeof setup>, token: string) => api.request(`/api/public/shares/${token}`);

describe('shared links', () => {
  it('show a page without signing in, and only that page', async () => {
    const { api, lisbon } = await withPages();
    const created = await api.call<Share>('POST', '/api/shares', { kind: 'page', targetId: lisbon.id });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ kind: 'page', title: 'Lisbon', includeChildren: false, trashed: false, viewCount: 0, expiresAt: null });
    expect(created.body.path).toMatch(/^\/s\/[A-Za-z0-9_-]{24}$/);

    api.logout();
    const res = await open(api, tokenOf(created.body));
    expect(res.status).toBe(200);
    expect(res.headers.get('x-robots-tag')).toBe('noindex, nofollow');
    expect(res.headers.get('cache-control')).toBe('no-store');
    const share = (await res.json()) as PublicShare;
    expect(share).toMatchObject({ kind: 'page', title: 'Lisbon', startId: lisbon.id, color: null });
    expect(share.pages.map((p) => p.title)).toEqual(['Lisbon']);
    expect(share.pages[0]!.content).toContain(`/api/public/shares/${tokenOf(created.body)}/attachments/`);
    expect(share.pages[0]!.content).not.toContain('](/api/attachments/');
  });

  it('include subpages when asked, and whole notebooks', async () => {
    const { api, nb, lisbon, porto, diary } = await withPages();
    const tree = (await api.call<Share>('POST', '/api/shares', { kind: 'page', targetId: lisbon.id, includeChildren: true })).body;
    const book = (await api.call<Share>('POST', '/api/shares', { kind: 'notebook', targetId: nb.id })).body;

    const subtree = (await (await open(api, tokenOf(tree))).json()) as PublicShare;
    expect(subtree.pages.map((p) => [p.title, p.parentId])).toEqual([
      ['Lisbon', null],
      ['Porto', lisbon.id],
    ]);
    const all = (await (await open(api, tokenOf(book))).json()) as PublicShare;
    expect(all.title).toBe('Travel');
    expect(all.pages.map((p) => p.id)).toEqual([lisbon.id, porto.id, diary.id]);

    // Pages added later are part of it; trashed ones drop out.
    await api.call('DELETE', `/api/pages/${diary.id}`);
    const later = (await (await open(api, tokenOf(book))).json()) as PublicShare;
    expect(later.pages.map((p) => p.title)).toEqual(['Lisbon', 'Porto']);
  });

  it('serve only the attachments shared pages link to', async () => {
    const { api, lisbon, photo, secret } = await withPages();
    const token = tokenOf((await api.call<Share>('POST', '/api/shares', { kind: 'page', targetId: lisbon.id })).body);
    api.logout();
    const id = (url: string) => url.split('/')[3]!;
    const ok = await api.request(`/api/public/shares/${token}/attachments/${id(photo.url)}/beach.png`);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe('fake-png');
    expect(ok.headers.get('content-security-policy')).toContain('sandbox');
    expect((await api.request(`/api/public/shares/${token}/attachments/${id(secret.url)}/secret.png`)).status).toBe(404);
    // And never through the normal route without a session.
    expect((await api.request(photo.url)).status).toBe(401);
  });

  it('stop working when turned off, expired or trashed', async () => {
    const { api, lisbon, porto } = await withPages();
    const forever = (await api.call<Share>('POST', '/api/shares', { kind: 'page', targetId: porto.id })).body;
    const week = (await api.call<Share>('POST', '/api/shares', { kind: 'page', targetId: lisbon.id, expiresInDays: 7 })).body;
    expect(week.expiresAt! - week.createdAt).toBe(7 * 24 * 60 * 60 * 1000);

    await api.call('DELETE', `/api/pages/${porto.id}`);
    expect((await open(api, tokenOf(forever))).status).toBe(404);
    let list = (await api.call<Share[]>('GET', '/api/shares')).body;
    expect(list.find((s) => s.id === forever.id)?.trashed).toBe(true);
    await api.call('POST', '/api/trash/restore', { kind: 'page', id: porto.id });
    expect((await open(api, tokenOf(forever))).status).toBe(200);

    expect((await api.call('DELETE', `/api/shares/${week.id}`)).status).toBe(204);
    const gone = await open(api, tokenOf(week));
    expect(gone.status).toBe(404);
    expect(((await gone.json()) as { error: string }).error).toMatch(/expired or been turned off/);

    list = (await api.call<Share[]>('GET', '/api/shares')).body;
    expect(list.map((s) => s.id)).toEqual([forever.id]);
    expect(list[0]!.viewCount).toBe(1); // the open while it was in the trash does not count
  });

  it('can only be managed by the signed-in owner', async () => {
    const { api, diary } = await withPages();
    const { token } = (await api.call<{ token: string }>('POST', '/api/tokens', { name: 'Script', scope: 'write' })).body;
    const asToken = await api.request('/api/shares', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'page', targetId: diary.id }),
    });
    expect(asToken.status).toBe(403);
    expect((await api.call('POST', '/api/shares', { kind: 'page', targetId: 'nope' })).status).toBe(404);
  });

  it('rate-limits guessing', async () => {
    const { api } = await withPages();
    for (let i = 0; i < 30; i++) await open(api, `guess${i}`);
    expect((await open(api, 'guess-again')).status).toBe(429);
  });
});
