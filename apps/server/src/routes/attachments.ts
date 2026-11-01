import { createReadStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { and, eq, isNull } from 'drizzle-orm';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { HTTPException } from 'hono/http-exception';
import { MAX_ATTACHMENT_BYTES, type Attachment } from '@nicotes/shared';
import type { AppEnv } from '../auth.js';
import type { Db } from '../db/index.js';
import { transcribe, TranscriptionError, type TranscriptionService } from '../ai/transcribe.js';
import { attachments, attachmentText, pages } from '../db/schema.js';
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
  'audio/webm',
  'audio/ogg',
  'audio/mp4',
  'audio/mpeg',
  'audio/wav',
]);

const safeName = (name: string) =>
  name.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').trim().slice(0, 200) || 'file';

const urlFor = (id: string, filename: string) => `/api/attachments/${id}/${encodeURIComponent(filename)}`;

/** Writes a file to the attachment store and records it. */
export async function storeAttachment(
  db: Db,
  dataDir: string,
  file: { userId: string; pageId: string | null; filename: string; mime: string; bytes: Buffer },
): Promise<Attachment> {
  const dir = join(dataDir, 'attachments');
  const id = newId();
  const filename = safeName(file.filename);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, id), file.bytes);
  db.insert(attachments)
    .values({
      id,
      userId: file.userId,
      pageId: file.pageId,
      filename,
      mime: file.mime,
      size: file.bytes.length,
      createdAt: Date.now(),
    })
    .run();
  return { id, url: urlFor(id, filename), filename, mime: file.mime, size: file.bytes.length };
}

/**
 * `onStored` runs after each upload, e.g. to read the file for search; `transcription` gives
 * the account's transcription service, if any.
 */
export function attachmentRoutes(
  db: Db,
  dataDir: string,
  onStored: () => void = () => {},
  transcription: (userId: string) => TranscriptionService | null = () => null,
) {

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

        const result = await storeAttachment(db, dataDir, {
          userId,
          pageId,
          filename: file.name,
          mime: file.type || 'application/octet-stream',
          bytes: Buffer.from(await file.arrayBuffer()),
        });
        onStored();
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
      return attachmentResponse(dataDir, row, 'private, max-age=31536000, immutable', c.req.header('range'));
    })
    // A voice note (or any audio file) as text, also kept for search.
    .post('/:id/transcribe', async (c) => {
      const userId = c.var.user.id;
      const row = db.select().from(attachments).where(and(eq(attachments.id, c.req.param('id')), eq(attachments.userId, userId))).get();
      if (!row) throw notFound('Attachment');
      if (!row.mime.startsWith('audio/') && row.mime !== 'video/webm') throw new HTTPException(400, { message: 'Only recordings can be transcribed' });
      const service = transcription(userId);
      if (!service) throw new HTTPException(400, { message: 'No transcription service is set up (Settings → Voice notes)' });
      let text: string;
      try {
        text = await transcribe(service, { bytes: await readFile(join(dataDir, 'attachments', row.id)), filename: row.filename, mime: row.mime });
      } catch (error) {
        if (error instanceof TranscriptionError) throw new HTTPException(502, { message: error.message });
        throw error;
      }
      const values = { userId, status: 'done', source: 'audio', text, error: null, updatedAt: Date.now() };
      db.insert(attachmentText)
        .values({ attachmentId: row.id, ...values })
        .onConflictDoUpdate({ target: attachmentText.attachmentId, set: values })
        .run();
      return c.json({ text });
    });
}

/**
 * The file itself, displayed inline where that is safe, never able to run scripts. Byte
 * ranges are served too: Safari only plays audio and video from servers that support them.
 */
export function attachmentResponse(dataDir: string, row: typeof attachments.$inferSelect, cacheControl: string, range?: string): Response {
  const inline = INLINE_TYPES.has(row.mime);
  const headers: Record<string, string> = {
    'Content-Type': row.mime,
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(row.filename)}`,
    'Cache-Control': cacheControl,
    'Accept-Ranges': 'bytes',
    'X-Content-Type-Options': 'nosniff',
    // Uploaded files never run scripts, even when opened directly (e.g. SVG, HTML).
    'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
  };
  const path = join(dataDir, 'attachments', row.id);
  const m = range ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : null;
  if (m && (m[1] || m[2]) && row.size > 0) {
    // "bytes=100-" (from 100), "bytes=-500" (the last 500), "bytes=0-99".
    const start = m[1] ? Number(m[1]) : Math.max(row.size - Number(m[2]), 0);
    const end = m[1] && m[2] ? Math.min(Number(m[2]), row.size - 1) : row.size - 1;
    if (start > end || start >= row.size) {
      return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${row.size}` } });
    }
    const stream = Readable.toWeb(createReadStream(path, { start, end })) as ReadableStream;
    return new Response(stream, {
      status: 206,
      headers: { ...headers, 'Content-Length': String(end - start + 1), 'Content-Range': `bytes ${start}-${end}/${row.size}` },
    });
  }
  const stream = Readable.toWeb(createReadStream(path)) as ReadableStream;
  return new Response(stream, { headers: { ...headers, 'Content-Length': String(row.size) } });
}
