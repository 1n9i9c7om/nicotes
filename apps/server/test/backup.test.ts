import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Attachment, BackupInfo, BackupStatus, Notebook, Page } from '@nicotes/shared';
import { createApp } from '../src/app.js';
import { extractTarGz, writeTarGz } from '../src/backup/archive.js';
import { restoreBackup } from '../src/backup/restore.js';
import { backupsToPrune, type BackupManifest } from '../src/backup/service.js';
import { openDb } from '../src/db/index.js';
import { migrationsFolder, setup } from './helpers.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const temp = (label: string) => mkdtempSync(join(tmpdir(), `nicotes-${label}-`));

/** An app with its own data and backup directories, an account, a page and an attachment. */
async function seeded(options: { secret?: string } = { secret: 'test-secret' }) {
  const dataDir = temp('data');
  const backupDir = temp('backups');
  const api = setup({ dataDir, backups: { dir: backupDir }, secret: options.secret });
  await api.call('POST', '/api/auth/setup', { username: 'nico', password: 'secret-pass' });
  const nb = (await api.call<Notebook>('POST', '/api/notebooks', { title: 'Games' })).body;
  const att = (await api.upload(new File([new Uint8Array([7, 8, 9])], 'map.png', { type: 'image/png' }))).body as Attachment;
  const page = (
    await api.call<Page>('POST', '/api/pages', { notebookId: nb.id, title: 'Elden Ring', content: `![map](${att.url})` })
  ).body;
  return { api, dataDir, backupDir, nb, att, page };
}

async function listArchive(file: string) {
  const dir = temp('extract');
  const names = await extractTarGz(file, (name) => join(dir, ...name.split('/')));
  return { dir, names };
}

describe('tar archives', () => {
  it('round-trips files of any size, including empty ones', async () => {
    const dir = temp('tar');
    const big = Buffer.alloc(1_300_001, 7);
    big.write('end', big.length - 3);
    writeFileSync(join(dir, 'big'), big);
    writeFileSync(join(dir, 'empty'), '');
    writeFileSync(join(dir, 'small'), 'hello');
    const file = join(dir, 'a.tar.gz');
    await writeTarGz(file, [
      { name: 'big', path: join(dir, 'big') },
      { name: 'sub/empty', path: join(dir, 'empty') },
      { name: 'missing', path: join(dir, 'nope') },
      { name: 'sub/small', path: join(dir, 'small') },
    ]);

    const { dir: out, names } = await listArchive(file);
    expect(names).toEqual(['big', 'sub/empty', 'sub/small']);
    expect(readFileSync(join(out, 'big')).equals(big)).toBe(true);
    expect(readFileSync(join(out, 'sub', 'empty')).length).toBe(0);
    expect(readFileSync(join(out, 'sub', 'small'), 'utf8')).toBe('hello');
  });

  it('rejects a truncated archive', async () => {
    const dir = temp('tar');
    writeFileSync(join(dir, 'data'), Buffer.alloc(200_000, 1).map((_, i) => i % 251));
    const file = join(dir, 'a.tar.gz');
    await writeTarGz(file, [{ name: 'data', path: join(dir, 'data') }]);
    truncateSync(file, Math.floor(statSync(file).size / 2));
    await expect(extractTarGz(file, () => null)).rejects.toThrow();
  });
});

describe('backup retention', () => {
  const now = Date.UTC(2026, 9, 20, 12);
  const at = (time: number) => ({ name: `b-${new Date(time).toISOString()}`, createdAt: time });

  it('keeps the last 24 hours, then the newest per day and per week', () => {
    const backups = [
      at(now - 1 * HOUR), // last 24 h
      at(now - 20 * HOUR), // last 24 h
      ...Array.from({ length: 40 }, (_, i) => at(now - (i + 1) * DAY - 2 * HOUR)), // one a day before that
      at(now - 3 * DAY - 6 * HOUR), // second backup on a day that already has a newer one
    ];
    const pruned = new Set(backupsToPrune(backups, { keepDaily: 7, keepWeekly: 4 }, now));
    const kept = backups.filter((b) => !pruned.has(b.name));

    expect(kept).toContainEqual(backups[0]);
    expect(kept).toContainEqual(backups[1]);
    expect(pruned.has(at(now - 3 * DAY - 6 * HOUR).name)).toBe(true);
    // 7 days (today counts as one) plus the newest of each of 4 weeks (this week counts as one).
    const oldest = Math.min(...kept.map((b) => b.createdAt));
    expect(now - oldest).toBeLessThan(28 * DAY);
    expect(now - oldest).toBeGreaterThan(14 * DAY);
    expect(kept.length).toBeLessThanOrEqual(2 + 7 + 4);
  });

  it('never deletes the newest backup, even an old one', () => {
    const backups = [at(now - 90 * DAY), at(now - 100 * DAY)];
    expect(backupsToPrune(backups, { keepDaily: 0, keepWeekly: 0 }, now)).toEqual([backups[1]!.name]);
  });

  it('counts days with backups, so a long pause keeps older backups', () => {
    const backups = Array.from({ length: 10 }, (_, i) => at(now - 60 * DAY - i * DAY));
    expect(backupsToPrune(backups, { keepDaily: 7, keepWeekly: 0 }, now)).toHaveLength(3);
  });

  it('deletes pruned archives from the backup directory', async () => {
    const { api, backupDir } = await seeded();
    const names = [
      'nicotes-2026-10-20T03-00-00Z.tar.gz',
      'nicotes-2026-10-19T09-00-00Z.tar.gz',
      'nicotes-2026-10-01T03-00-00Z.tar.gz',
      'nicotes-2026-10-01T02-00-00Z.tar.gz',
    ];
    for (const n of names) writeFileSync(join(backupDir, n), 'x');
    writeFileSync(join(backupDir, 'notes.txt'), 'not a backup');

    const removed = await api.backups.prune(now);
    expect(removed).toEqual(['nicotes-2026-10-01T02-00-00Z.tar.gz']);
    expect(readdirSync(backupDir).sort()).toEqual([...names.slice(0, 3), 'notes.txt'].sort());
  });
});

describe('backups', () => {
  it('archives the database, attachments and a manifest', async () => {
    const { api, backupDir, att } = await seeded();
    const res = await api.call<BackupInfo>('POST', '/api/backups');
    expect(res.status).toBe(200);
    expect(res.body.name).toMatch(/^nicotes-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z\.tar\.gz$/);
    // Only the finished archive is left behind, no work files.
    expect(readdirSync(backupDir)).toEqual([res.body.name]);

    const { dir, names } = await listArchive(join(backupDir, res.body.name));
    expect(names.sort()).toEqual(['attachments/' + att.id, 'manifest.json', 'nicotes.db'].sort());
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as BackupManifest;
    expect(manifest).toMatchObject({ format: 1, attachments: 1, secretFromEnv: true });
    expect([...readFileSync(join(dir, 'attachments', att.id))]).toEqual([7, 8, 9]);

    const copy = openDb(join(dir, 'nicotes.db'), migrationsFolder);
    expect(copy.$client.prepare('select title from pages').all()).toEqual([{ title: 'Elden Ring' }]);
    copy.$client.close();
  });

  it('includes the generated key file when NICOTES_SECRET is not set', async () => {
    const { api, backupDir, dataDir } = await seeded({ secret: undefined });
    const info = (await api.call<BackupInfo>('POST', '/api/backups')).body;
    const { dir, names } = await listArchive(join(backupDir, info.name));
    expect(names).toContain('secret.key');
    expect(readFileSync(join(dir, 'secret.key'), 'utf8')).toBe(readFileSync(join(dataDir, 'secret.key'), 'utf8'));
  });

  it('lists and downloads backups, and refuses other files', async () => {
    const { api } = await seeded();
    const info = (await api.call<BackupInfo>('POST', '/api/backups')).body;
    const second = (await api.call<BackupInfo>('POST', '/api/backups')).body;
    expect(second.name).not.toBe(info.name);

    const status = (await api.call<BackupStatus>('GET', '/api/backups')).body;
    expect(status.backups.map((b) => b.name)).toEqual([second.name, info.name].sort().reverse());
    expect(status).toMatchObject({ running: false, lastError: null, intervalHours: 0, nextAt: null });

    const download = await api.raw(`/api/backups/${info.name}`);
    expect(download.status).toBe(200);
    expect(download.headers.get('content-disposition')).toContain(info.name);
    expect((await download.arrayBuffer()).byteLength).toBe(info.size);

    expect((await api.raw('/api/backups/..%2Fnicotes.db')).status).toBe(404);
    expect((await api.raw('/api/backups/nicotes-2026-01-01T00-00-00Z.tar.gz')).status).toBe(404);
    api.logout();
    expect((await api.raw(`/api/backups/${info.name}`)).status).toBe(401);
    expect((await api.call('POST', '/api/backups')).status).toBe(401);
  });

  it('restores pages and attachments into an empty data directory', async () => {
    const { api, backupDir, att } = await seeded();
    const info = (await api.call<BackupInfo>('POST', '/api/backups')).body;

    const target = temp('restore');
    const result = await restoreBackup(join(backupDir, info.name), target);
    expect(result).toMatchObject({ attachments: 1, previous: null });
    expect(readdirSync(target).sort()).toEqual(['attachments', 'nicotes.db']);

    // Start a server on the restored data, as after a real restore.
    const db = openDb(join(target, 'nicotes.db'), migrationsFolder);
    const restored = createApp({ db, secureCookies: false, dataDir: target, secret: 'test-secret' });
    const login = await restored.request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'nico', password: 'secret-pass' }),
    });
    expect(login.status).toBe(200);
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    const pages = (await (await restored.request('/api/pages', { headers: { cookie } })).json()) as Page[];
    expect(pages.map((p) => p.title)).toEqual(['Elden Ring']);
    const file = await restored.request(att.url, { headers: { cookie } });
    expect([...new Uint8Array(await file.arrayBuffer())]).toEqual([7, 8, 9]);
    db.$client.close();
  });

  it('moves the current data aside, including stale WAL files', async () => {
    const { api, backupDir } = await seeded();
    const info = (await api.call<BackupInfo>('POST', '/api/backups')).body;

    const target = temp('restore');
    writeFileSync(join(target, 'nicotes.db'), 'old database');
    writeFileSync(join(target, 'nicotes.db-wal'), 'old wal');
    mkdirSync(join(target, 'attachments'));
    writeFileSync(join(target, 'attachments', 'old'), 'old file');
    mkdirSync(join(target, 'backups'));

    const result = await restoreBackup(join(backupDir, info.name), target);
    expect(result.previous).toBeTruthy();
    expect(readdirSync(result.previous!).sort()).toEqual(['attachments', 'nicotes.db', 'nicotes.db-wal']);
    expect(existsSync(join(target, 'nicotes.db-wal'))).toBe(false);
    expect(existsSync(join(target, 'attachments', 'old'))).toBe(false);
    expect(existsSync(join(target, 'backups'))).toBe(true);
  });

  it('leaves the data directory alone when the archive is broken', async () => {
    const { api, backupDir } = await seeded();
    const info = (await api.call<BackupInfo>('POST', '/api/backups')).body;
    const broken = join(temp('broken'), info.name);
    writeFileSync(broken, readFileSync(join(backupDir, info.name)).subarray(0, 200));

    const target = temp('restore');
    writeFileSync(join(target, 'nicotes.db'), 'current database');
    await expect(restoreBackup(broken, target)).rejects.toThrow();
    expect(readdirSync(target)).toEqual(['nicotes.db']);
    expect(readFileSync(join(target, 'nicotes.db'), 'utf8')).toBe('current database');

    const other = join(temp('other'), 'other.tar.gz');
    const dir = temp('src');
    writeFileSync(join(dir, 'x'), 'x');
    await writeTarGz(other, [{ name: 'x', path: join(dir, 'x') }]);
    await expect(restoreBackup(other, target)).rejects.toThrow('not a Nicotes backup');
    expect(readdirSync(target)).toEqual(['nicotes.db']);
  });
});
