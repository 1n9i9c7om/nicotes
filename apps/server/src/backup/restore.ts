import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { extractTarGz } from './archive.js';
import { BACKUP_FORMAT, type BackupManifest } from './service.js';

/** What a restore replaces in the data directory (the WAL files must go with the database). */
const DATA_ITEMS = ['nicotes.db', 'nicotes.db-wal', 'nicotes.db-shm', 'attachments', 'secret.key'];

export interface RestoreResult {
  manifest: BackupManifest;
  attachments: number;
  /** Where the previous data was moved; null when the data directory was empty. */
  previous: string | null;
}

/** Only names a backup can contain are extracted, which also rules out paths outside `dir`. */
function stagingPath(dir: string) {
  return (name: string) => {
    if (name === 'manifest.json' || name === 'nicotes.db' || name === 'secret.key') return join(dir, name);
    const m = /^attachments\/([\w-]+)$/.exec(name);
    return m ? join(dir, 'attachments', m[1]!) : null;
  };
}

function checkDatabase(file: string) {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const result = db.pragma('integrity_check', { simple: true });
    if (result !== 'ok') throw new Error(`The database in the backup is damaged (${String(result)})`);
    if (!db.prepare("select 1 from sqlite_master where type = 'table' and name = 'pages'").get()) {
      throw new Error('The database in the backup is not a Nicotes database');
    }
  } finally {
    db.close();
  }
}

/**
 * Restores a backup archive into `dataDir`. The server must not be running. Nothing is
 * deleted: the current database, attachments and key file are moved to a `pre-restore-…`
 * folder first. The archive is unpacked and checked before anything is moved, so a broken
 * archive leaves the data directory untouched.
 */
export async function restoreBackup(archive: string, dataDir: string): Promise<RestoreResult> {
  if (!existsSync(archive)) throw new Error(`Backup not found: ${archive}`);
  await mkdir(dataDir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
  const staging = join(dataDir, `.restore-${stamp}`);
  // Staging inside dataDir keeps the final moves on one file system (plain renames).
  await mkdir(staging, { recursive: true });

  let manifest: BackupManifest;
  let attachments: number;
  try {
    const names = await extractTarGz(archive, stagingPath(staging));
    if (!names.includes('manifest.json') || !names.includes('nicotes.db')) {
      throw new Error('This is not a Nicotes backup (manifest.json or nicotes.db missing)');
    }
    manifest = JSON.parse(await readFile(join(staging, 'manifest.json'), 'utf8')) as BackupManifest;
    if (manifest.format !== BACKUP_FORMAT) {
      throw new Error(`Unsupported backup format ${manifest.format}; this version reads format ${BACKUP_FORMAT}`);
    }
    checkDatabase(join(staging, 'nicotes.db'));
    attachments = names.filter((n) => n.startsWith('attachments/')).length;
    await mkdir(join(staging, 'attachments'), { recursive: true });
  } catch (err) {
    await rm(staging, { recursive: true, force: true });
    throw err;
  }

  const previous = join(dataDir, `pre-restore-${stamp}`);
  const moved: string[] = [];
  const placed: string[] = [];
  try {
    await mkdir(previous);
    for (const item of DATA_ITEMS) {
      if (!existsSync(join(dataDir, item))) continue;
      await rename(join(dataDir, item), join(previous, item));
      moved.push(item);
    }
    for (const item of ['nicotes.db', 'attachments', 'secret.key']) {
      if (!existsSync(join(staging, item))) continue;
      await rename(join(staging, item), join(dataDir, item));
      placed.push(item);
    }
  } catch (err) {
    // Put the previous data back so the server starts as before.
    for (const item of placed) await rm(join(dataDir, item), { recursive: true, force: true }).catch(() => {});
    for (const item of moved) await rename(join(previous, item), join(dataDir, item)).catch(() => {});
    await rm(staging, { recursive: true, force: true });
    throw err;
  }
  await rm(staging, { recursive: true, force: true });
  if (!moved.length) await rmdir(previous);
  return { manifest, attachments, previous: moved.length ? previous : null };
}
