import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import { Hono } from 'hono';
import type { SystemInfo } from '@nicotes/shared';
import type { AppEnv } from './auth.js';
import type { Db } from './db/index.js';

// apps/server/package.json, one level above both src/ (dev) and dist/ (production).
const packageVersion = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;
const env = (name: string) => process.env[name]?.trim() || null;

/** The running version: the release tag CI built from, else package.json's version. */
export const version = env('NICOTES_VERSION') ?? packageVersion;

export function systemInfo(db: Db, userId: string, dataDir: string): SystemInfo {
  const get = <T>(query: string, params?: object) => {
    const statement = db.$client.prepare(query);
    return (params ? statement.get(params) : statement.get()) as T;
  };
  const { pageCount, pageSize } = get<{ pageCount: number; pageSize: number }>(
    'SELECT (SELECT page_count FROM pragma_page_count()) AS pageCount, (SELECT page_size FROM pragma_page_size()) AS pageSize',
  );
  // Drizzle records applied migrations here; the table exists once the server has started.
  const migrations = get<{ n: number }>('SELECT count(*) AS n FROM __drizzle_migrations').n;
  const data = get<SystemInfo['data']>(
    `SELECT
       (SELECT count(*) FROM notebooks WHERE user_id = @u AND deleted_at IS NULL) AS notebooks,
       (SELECT count(*) FROM pages WHERE user_id = @u AND deleted_at IS NULL) AS pages,
       (SELECT count(*) FROM pages WHERE user_id = @u AND deleted_at IS NOT NULL) AS trash,
       (SELECT count(*) FROM attachments WHERE user_id = @u) AS attachments,
       (SELECT coalesce(sum(size), 0) FROM attachments WHERE user_id = @u) AS attachmentBytes,
       (SELECT count(*) FROM page_versions WHERE user_id = @u) AS versions`,
    { u: userId },
  );
  return {
    version,
    build: { ref: env('NICOTES_BUILD_REF'), commit: env('NICOTES_BUILD_COMMIT'), date: env('NICOTES_BUILD_DATE') },
    server: {
      node: process.version,
      os: `${os.type()} ${os.release()}`,
      arch: process.arch,
      docker: existsSync('/.dockerenv'),
      uptime: Math.round(process.uptime()),
    },
    database: {
      sqlite: get<{ v: string }>('SELECT sqlite_version() AS v').v,
      size: pageCount * pageSize,
      migrations,
    },
    data,
    dataDir,
  };
}

export function systemRoutes(db: Db, dataDir: string) {
  return new Hono<AppEnv>().get('/', (c) => c.json(systemInfo(db, c.var.user.id, dataDir)));
}
