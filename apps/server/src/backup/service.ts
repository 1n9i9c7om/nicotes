import { existsSync } from 'node:fs';
import { mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BackupInfo, BackupStatus } from '@nicotes/shared';
import type { Db } from '../db/index.js';
import { writeTarGz, type TarSource } from './archive.js';

export interface BackupOptions {
  /** Where archives are written (NICOTES_BACKUP_DIR, default `<dataDir>/backups`). */
  dir: string;
  /** Hours between automatic backups; 0 turns them off. */
  intervalHours: number;
  /** Keep the newest backup of each of the last N days … */
  keepDaily: number;
  /** … and of each of the last N weeks. */
  keepWeekly: number;
}

/** Bumped when the archive layout changes; restore refuses formats it does not know. */
export const BACKUP_FORMAT = 1;

export interface BackupManifest {
  format: number;
  createdAt: number;
  attachments: number;
  /** The key came from NICOTES_SECRET, so secret.key is not in the archive. */
  secretFromEnv: boolean;
}

const NAME = /^nicotes-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})Z(?:-(\d+))?\.tar\.gz$/;
const HOUR = 60 * 60 * 1000;
/** Scheduled checks; cheap (one directory listing), so missed slots after sleep or restarts are caught up quickly. */
const CHECK_EVERY = 10 * 60 * 1000;
/** After a failure (disk full, NAS offline) wait this long before the next automatic try. */
const RETRY_AFTER = HOUR;

export const isBackupName = (name: string) => NAME.test(name);

function parseName(name: string): number | null {
  const m = NAME.exec(name);
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1, 7).map(Number) as [number, number, number, number, number, number];
  return Date.UTC(y, mo - 1, d, h, mi, s);
}

function nameFor(time: number, n: number) {
  // UTC in the name: unambiguous across time zone and DST changes, and it sorts.
  const stamp = new Date(time).toISOString().slice(0, 19).replace(/:/g, '-');
  return `nicotes-${stamp}Z${n > 1 ? `-${n}` : ''}.tar.gz`;
}

const localDay = (time: number) => {
  const d = new Date(time);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
};
/** The local date of the week's Monday identifies the (ISO) week. */
const localWeek = (time: number) => {
  const d = new Date(time);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return localDay(d.getTime());
};

/**
 * Names of backups that retention removes. Kept: the newest backup, everything from the last
 * 24 hours (so a manual backup before a risky change survives the next scheduled one), and the
 * newest backup of each of the last `keepDaily` days and `keepWeekly` weeks that have backups.
 * Counting days with backups rather than calendar days means a server that was off for a
 * while does not lose its older backups.
 */
export function backupsToPrune(
  backups: Pick<BackupInfo, 'name' | 'createdAt'>[],
  policy: Pick<BackupOptions, 'keepDaily' | 'keepWeekly'>,
  now = Date.now(),
): string[] {
  const sorted = [...backups].sort((a, b) => b.createdAt - a.createdAt || b.name.localeCompare(a.name));
  const keep = new Set<string>(sorted.slice(0, 1).map((b) => b.name));
  for (const b of sorted) if (now - b.createdAt < 24 * HOUR) keep.add(b.name);
  for (const [period, limit] of [
    [localDay, policy.keepDaily],
    [localWeek, policy.keepWeekly],
  ] as const) {
    const seen = new Set<string>();
    for (const b of sorted) {
      const key = period(b.createdAt);
      if (seen.has(key) || seen.size >= limit) continue;
      seen.add(key);
      keep.add(b.name);
    }
  }
  return sorted.filter((b) => !keep.has(b.name)).map((b) => b.name);
}

/** Creates, lists and prunes backups, and runs them on a schedule. */
export class BackupService {
  private running: Promise<BackupInfo> | null = null;
  private lastError: BackupStatus['lastError'] = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private db: Db,
    private dataDir: string,
    readonly options: BackupOptions,
    private secretFromEnv: boolean,
  ) {}

  async list(): Promise<BackupInfo[]> {
    const names = await readdir(this.options.dir).catch(() => [] as string[]);
    const backups: BackupInfo[] = [];
    for (const name of names) {
      const createdAt = parseName(name);
      if (createdAt === null) continue;
      const info = await stat(join(this.options.dir, name)).catch(() => null);
      if (info?.isFile()) backups.push({ name, createdAt, size: info.size });
    }
    return backups.sort((a, b) => b.createdAt - a.createdAt || b.name.localeCompare(a.name));
  }

  async status(): Promise<BackupStatus> {
    const backups = await this.list();
    const { dir, intervalHours, keepDaily, keepWeekly } = this.options;
    return {
      dir,
      intervalHours,
      keepDaily,
      keepWeekly,
      running: this.running !== null,
      nextAt: intervalHours > 0 ? (backups[0]?.createdAt ?? Date.now()) + intervalHours * HOUR : null,
      lastError: this.lastError,
      backups,
    };
  }

  /** Full path of a backup file, or null for names that are not backups (no path tricks). */
  pathOf(name: string): string | null {
    return isBackupName(name) ? join(this.options.dir, name) : null;
  }

  /** Creates a backup and applies retention. Concurrent calls share the running backup. */
  run(): Promise<BackupInfo> {
    this.running ??= this.create()
      .then(async (info) => {
        this.lastError = null;
        await this.prune();
        return info;
      })
      .catch((err: unknown) => {
        this.lastError = { at: Date.now(), message: err instanceof Error ? err.message : String(err) };
        throw err;
      })
      .finally(() => (this.running = null));
    return this.running;
  }

  private async create(): Promise<BackupInfo> {
    const { dir } = this.options;
    await mkdir(dir, { recursive: true });
    // Whole seconds, as the time is read back from the file name.
    const createdAt = Math.floor(Date.now() / 1000) * 1000;
    let name = nameFor(createdAt, 1);
    for (let n = 2; existsSync(join(dir, name)); n++) name = nameFor(createdAt, n);
    // Work files are hidden and renamed into place only when complete, so an interrupted run
    // never leaves something that looks like a usable backup.
    const work = join(dir, `.${name}.partial`);
    const dbCopy = `${work}.db`;
    const manifestFile = `${work}.json`;
    try {
      // SQLite's online backup API: a consistent snapshot while the app keeps writing.
      await this.db.$client.backup(dbCopy);

      const attachmentDir = join(this.dataDir, 'attachments');
      const attachmentNames = (await readdir(attachmentDir).catch(() => [] as string[])).filter((n) => /^[\w-]+$/.test(n));
      const manifest: BackupManifest = {
        format: BACKUP_FORMAT,
        createdAt,
        attachments: attachmentNames.length,
        secretFromEnv: this.secretFromEnv,
      };
      await writeFile(manifestFile, JSON.stringify(manifest, null, 2));

      const sources: TarSource[] = [
        { name: 'manifest.json', path: manifestFile },
        { name: 'nicotes.db', path: dbCopy },
        { name: 'secret.key', path: join(this.dataDir, 'secret.key') }, // skipped when absent
        ...attachmentNames.map((n) => ({ name: `attachments/${n}`, path: join(attachmentDir, n) })),
      ];
      await writeTarGz(work, sources);
      await rename(work, join(dir, name));
      const { size } = await stat(join(dir, name));
      return { name, createdAt, size };
    } finally {
      await Promise.all([work, dbCopy, manifestFile].map((f) => rm(f, { force: true })));
    }
  }

  /** Deletes backups that fall outside the retention policy. */
  async prune(now = Date.now()): Promise<string[]> {
    const removed = backupsToPrune(await this.list(), this.options, now);
    for (const name of removed) await rm(join(this.options.dir, name), { force: true });
    return removed;
  }

  private async due(): Promise<boolean> {
    if (this.running) return false;
    if (this.lastError && Date.now() - this.lastError.at < RETRY_AFTER) return false;
    const [newest] = await this.list();
    // A minute of slack so a check that fires just before the mark does not wait another round.
    return !newest || Date.now() - newest.createdAt >= this.options.intervalHours * HOUR - 60_000;
  }

  /** Starts automatic backups (if an interval is configured). */
  start() {
    const { intervalHours, dir, keepDaily, keepWeekly } = this.options;
    if (intervalHours <= 0) {
      console.log('Automatic backups are off (NICOTES_BACKUP_INTERVAL_HOURS=0)');
      return;
    }
    console.log(`Backups every ${intervalHours} h to ${dir} (keeping ${keepDaily} daily, ${keepWeekly} weekly)`);
    void this.removeLeftovers();
    const check = async () => {
      try {
        if (await this.due()) {
          const info = await this.run();
          console.log(`Backup written: ${info.name} (${Math.round(info.size / 1024)} KB)`);
        }
      } catch (err) {
        console.error('Backup failed:', err);
      }
    };
    // First check shortly after start-up, not during it.
    this.timer = setTimeout(() => {
      void check();
      this.timer = setInterval(() => void check(), CHECK_EVERY);
      this.timer.unref();
    }, 30_000);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Work files of a run that was interrupted (crash, restart). */
  private async removeLeftovers() {
    const names = await readdir(this.options.dir).catch(() => [] as string[]);
    for (const name of names) {
      if (name.startsWith('.nicotes-') && name.includes('.partial')) await rm(join(this.options.dir, name), { force: true });
    }
  }
}
