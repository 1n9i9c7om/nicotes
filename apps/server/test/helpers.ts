import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import { openDb } from '../src/db/index.js';

export const migrationsFolder = fileURLToPath(new URL('../drizzle', import.meta.url));
export const dataDir = mkdtempSync(join(tmpdir(), 'nicotes-test-'));

/** In-memory app plus a tiny cookie-keeping client. */
export function setup() {
  const db = openDb(':memory:', migrationsFolder);
  const app = createApp({ db, secureCookies: false, dataDir });
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

  /** Multipart upload, as the web app sends it. */
  async function upload(file: File, headers: Record<string, string> = { 'x-requested-with': 'nicotes' }) {
    const form = new FormData();
    form.set('file', file);
    const res = await app.request('/api/attachments', { method: 'POST', headers: { cookie, ...headers }, body: form });
    return { status: res.status, body: (await res.json()) as { url: string; mime: string; size: number } };
  }

  const raw = (path: string) => app.request(path, { headers: { cookie } });

  return { call, upload, raw, logout: () => (cookie = '') };
}
