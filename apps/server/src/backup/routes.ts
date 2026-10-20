import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { AppEnv } from '../auth.js';
import { notFound } from '../http.js';
import type { BackupService } from './service.js';

/**
 * Backups cover the whole instance (all accounts), like the data directory itself. That is
 * fine while Nicotes has a single account; multi-user would need an admin role here.
 */
export function backupRoutes(backups: BackupService) {
  return new Hono<AppEnv>()
    .get('/', async (c) => c.json(await backups.status()))
    .post('/', async (c) => {
      try {
        return c.json(await backups.run());
      } catch (err) {
        // Shown in Settings: "disk full" or "permission denied" tells the user what to fix.
        throw new HTTPException(500, { message: `Backup failed: ${err instanceof Error ? err.message : String(err)}` });
      }
    })
    .get('/:name', async (c) => {
      const name = c.req.param('name');
      const path = backups.pathOf(name);
      const info = path ? await stat(path).catch(() => null) : null;
      if (!path || !info?.isFile()) throw notFound('Backup');
      return new Response(Readable.toWeb(createReadStream(path)) as ReadableStream, {
        headers: {
          'Content-Type': 'application/gzip',
          'Content-Length': String(info.size),
          'Content-Disposition': `attachment; filename="${name}"`,
          'Cache-Control': 'no-store',
        },
      });
    });
}
