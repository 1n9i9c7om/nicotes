import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Notebook, Page, SystemInfo } from '@nicotes/shared';
import { setup } from './helpers.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };

describe('system info', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('reports version, build, runtime, database and the user’s data', async () => {
    const api = setup();
    await api.call('POST', '/api/auth/setup', { username: 'nico', password: 'secret-pass' });
    const nb = (await api.call<Notebook>('POST', '/api/notebooks', { title: 'Notes' })).body;
    const page = (await api.call<Page>('POST', '/api/pages', { notebookId: nb.id, title: 'A', content: 'x' })).body;
    await api.call('POST', '/api/pages', { notebookId: nb.id, title: 'B' });
    await api.call('DELETE', `/api/pages/${page.id}`);

    const res = await api.call<SystemInfo>('GET', '/api/system');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      version: pkg.version,
      build: { ref: null, commit: null, date: null },
      server: { node: process.version, arch: process.arch },
      data: { notebooks: 1, pages: 1, trash: 1, attachments: 0, attachmentBytes: 0 },
    });
    expect(res.body.database.migrations).toBeGreaterThanOrEqual(10);
    expect(res.body.database.size).toBeGreaterThan(0);
    expect(res.body.database.sqlite).toMatch(/^3\./);
  });

  it('shows the build CI passed in', async () => {
    vi.stubEnv('NICOTES_BUILD_REF', 'main');
    vi.stubEnv('NICOTES_BUILD_COMMIT', 'abc1234');
    const api = setup();
    await api.call('POST', '/api/auth/setup', { username: 'nico', password: 'secret-pass' });
    expect((await api.call<SystemInfo>('GET', '/api/system')).body.build).toMatchObject({ ref: 'main', commit: 'abc1234' });
  });

  it('is only for signed-in users', async () => {
    expect((await setup().call('GET', '/api/system')).status).toBe(401);
  });
});
