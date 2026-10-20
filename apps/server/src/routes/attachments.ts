import { createReadStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { and, eq, isNull } from 'drizzle-orm';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { HTTPException } from 'hono/http-exception';
import { MAX_ATTACHMENT_BYTES, type Attachment } from '@nicotes/shared';
import type { AppEnv } from '../auth.js';
import type { Db } from '../db/index.js';
import { attachments, pages } from '../db/schema.js';
import { notFound } from '../http.js';
import { newId } from '../ids.js';

/** Types the browser may display inline; everything else is served as a download. */
const INLINE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/svg+xml',
  'application/pdf',
  'text/plain',
]);

const safeName = (name: string) =>
  name.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').trim().slice(0, 200) || 'file';

const urlFor = (id: string, filename: string) => `/api/attachments/${id}/${encodeURIComponent(filename)}`;

export function attachmentRoutes(db: Db, dataDir: string) {
  const dir = join(dataDir, 'attachments');

  return new Hono<AppEnv>()
    .post(
      '/',
      bodyLimit({
        maxSize: MAX_ATTACHMENT_BYTES + 64 * 1024,
        onError: (c) => c.json({ error: 'File is too large (max 25 MB)' }, 413),
      }),
      async (c) => {
        const body = await c.req.parseBody();
        const file = body.file;
        if (!(file instanceof File)) throw new HTTPException(400, { message: 'Missing file' });
        if (file.size > MAX_ATTACHMENT_BYTES) throw new HTTPException(413, { message: 'File is too large (max 25 MB)' });

        const userId = c.var.user.id;
        const pageId = typeof body.pageId === 'string' && body.pageId ? body.pageId : null;
        if (pageId) {
          const page = db
            .select({ id: pages.id })
            .from(pages)
            .where(and(eq(pages.id, pageId), eq(pages.userId, userId), isNull(pages.deletedAt)))
            .get();
          if (!page) throw notFound('Page');
        }

        const id = newId();
        const filename = safeName(file.name);
        const mime = file.type || 'application/octet-stream';
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, id), Buffer.from(await file.arrayBuffer()));
        db.insert(attachments)
          .values({ id, userId, pageId, filename, mime, size: file.size, createdAt: Date.now() })
          .run();

        const result: Attachment = { id, url: urlFor(id, filename), filename, mime, size: file.size };
        return c.json(result, 201);
      },
    )
    .get('/:id/:filename?', (c) => {
      const row = db
        .select()
        .from(attachments)
        .where(and(eq(attachments.id, c.req.param('id')), eq(attachments.userId, c.var.user.id)))
        .get();
      if (!row) throw notFound('Attachment');

      const inline = INLINE_TYPES.has(row.mime);
      const disposition = `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(row.filename)}`;
      const stream = Readable.toWeb(createReadStream(join(dir, row.id))) as ReadableStream;
      return new Response(stream, {
        headers: {
          'Content-Type': row.mime,
          'Content-Length': String(row.size),
          'Content-Disposition': disposition,
          'Cache-Control': 'private, max-age=31536000, immutable',
          'X-Content-Type-Options': 'nosniff',
          // Uploaded files never run scripts, even when opened directly (e.g. SVG, HTML).
          'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
        },
      });
    });
}
