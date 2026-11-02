import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApiToken, CreatedApiToken, Notebook } from '@nicotes/shared';
import { setup } from './helpers.js';

async function signedIn() {
  const api = setup();
  await api.call('POST', '/api/auth/setup', { username: 'nico', password: 'secret-pass' });
  return api;
}

const bearer = (token: string, extra: Record<string, string> = {}) => ({ headers: { authorization: `Bearer ${token}`, ...extra } });

describe('API tokens', () => {
  afterEach(() => vi.useRealTimers());

  it('are shown once when created and listed without the token itself', async () => {
    const api = await signedIn();
    const created = await api.call<CreatedApiToken>('POST', '/api/tokens', { name: 'Home Assistant', scope: 'write' });
    expect(created.status).toBe(201);
    expect(created.body.token).toMatch(/^nct_[\w-]{43}$/);
    expect(created.body.info).toMatchObject({ name: 'Home Assistant', scope: 'write', hint: created.body.token.slice(-4), lastUsedAt: null, expiresAt: null });

    const list = await api.call<ApiToken[]>('GET', '/api/tokens');
    expect(list.body).toEqual([created.body.info]);
    expect(JSON.stringify(list.body)).not.toContain(created.body.token);
  });

  it('let scripts read and, with write access, change notes without a session', async () => {
    const api = await signedIn();
    const read = (await api.call<CreatedApiToken>('POST', '/api/tokens', { name: 'Backup script', scope: 'read' })).body.token;
    const write = (await api.call<CreatedApiToken>('POST', '/api/tokens', { name: 'Shortcuts', scope: 'write' })).body.token;
    await api.call('POST', '/api/notebooks', { title: 'Projects' });

    const listed = await api.request('/api/notebooks', bearer(read));
    expect(listed.status).toBe(200);
    expect(((await listed.json()) as Notebook[]).map((n) => n.title)).toEqual(['Projects']);

    const json = { 'content-type': 'application/json' };
    const refused = await api.request('/api/notebooks', { method: 'POST', body: JSON.stringify({ title: 'X' }), ...bearer(read, json) });
    expect(refused.status).toBe(403);
    expect(await refused.text()).toContain('This API token may only read');

    const made = await api.request('/api/notebooks', { method: 'POST', body: JSON.stringify({ title: 'Inbox' }), ...bearer(write, json) });
    expect(made.status).toBe(201);
    // A token request needs no CSRF header for uploads.
    const form = new FormData();
    form.set('file', new File(['hello'], 'note.txt', { type: 'text/plain' }));
    const uploaded = await api.request('/api/attachments', { method: 'POST', body: form, ...bearer(write) });
    expect(uploaded.status).toBe(201);

    const info = (await api.call<ApiToken[]>('GET', '/api/tokens')).body;
    expect(info.every((t) => t.lastUsedAt !== null)).toBe(true);
  });

  it('cannot reach settings, backups or the tokens themselves', async () => {
    const api = await signedIn();
    const token = (await api.call<CreatedApiToken>('POST', '/api/tokens', { name: 'All', scope: 'write' })).body.token;
    for (const path of ['/api/settings', '/api/backups', '/api/tokens']) {
      const res = await api.request(path, bearer(token));
      expect(res.status, path).toBe(403);
      expect(await res.text()).toContain('API tokens cannot be used for this');
    }
  });

  it('stop working when revoked or expired', async () => {
    const api = await signedIn();
    const expiring = await api.call<CreatedApiToken>('POST', '/api/tokens', { name: 'Trial', scope: 'read', expiresInDays: 1 });
    expect(expiring.body.info.expiresAt).toBeGreaterThan(Date.now());
    const kept = await api.call<CreatedApiToken>('POST', '/api/tokens', { name: 'Kept', scope: 'read' });

    expect((await api.request('/api/notebooks', bearer(expiring.body.token))).status).toBe(200);
    vi.useFakeTimers({ now: Date.now() + 2 * 24 * 60 * 60 * 1000, toFake: ['Date'] });
    expect((await api.request('/api/notebooks', bearer(expiring.body.token))).status).toBe(401);
    vi.useRealTimers();

    expect((await api.call('DELETE', `/api/tokens/${kept.body.info.id}`)).status).toBe(204);
    const revoked = await api.request('/api/notebooks', bearer(kept.body.token));
    expect(revoked.status).toBe(401);
    expect(await revoked.text()).toContain('Unknown or expired API token');
  });

  it('belong to their user', async () => {
    const api = await signedIn();
    const mine = (await api.call<CreatedApiToken>('POST', '/api/tokens', { name: 'Mine', scope: 'read' })).body.info;
    api.logout();
    // Without a session, neither listing nor revoking works.
    expect((await api.call('GET', '/api/tokens')).status).toBe(401);
    expect((await api.call('DELETE', `/api/tokens/${mine.id}`)).status).toBe(401);
    expect((await api.call('DELETE', '/api/tokens/unknown')).status).toBe(401);
  });

  it('slow down guessing', async () => {
    const api = await signedIn();
    for (let i = 0; i < 20; i++) expect((await api.request('/api/notebooks', bearer(`nct_wrong${i}`))).status).toBe(401);
    expect((await api.request('/api/notebooks', bearer('nct_wrong'))).status).toBe(429);
  });
});
