import { randomBytes } from 'node:crypto';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { shareCreateSchema, sharePath, type PublicShare, type Share } from '@nicotes/shared';
import { hashToken, LoginLimiter, type AppEnv } from '../auth.js';
import type { Db } from '../db/index.js';
import { attachments, notebooks, pages, shares } from '../db/schema.js';
import { clientIp, notFound, readJson } from '../http.js';
import { newId } from '../ids.js';
import type { SecretBox } from '../secrets.js';
import { attachmentResponse } from './attachments.js';

type ShareRow = typeof shares.$inferSelect;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The page or notebook a link points at; null once it is gone for good. */
function targetOf(db: Db, row: Pick<ShareRow, 'kind' | 'targetId' | 'userId'>) {
  const table = row.kind === 'notebook' ? notebooks : pages;
  const found = db
    .select({ title: table.title, deletedAt: table.deletedAt })
    .from(table)
    .where(and(eq(table.id, row.targetId), eq(table.userId, row.userId)))
    .get();
  return found ? { title: found.title, trashed: found.deletedAt !== null } : null;
}

/**
 * The pages a link shows, in tree order: the notebook's pages, or the page (with its
 * subpages if chosen). Trashed pages are left out. Parents outside the share become null.
 */
function sharedTree(db: Db, row: ShareRow): { id: string; parentId: string | null }[] {
  const live = and(eq(pages.userId, row.userId), isNull(pages.deletedAt));
  let notebookId = row.targetId;
  if (row.kind === 'page') {
    const page = db.select({ notebookId: pages.notebookId }).from(pages).where(and(eq(pages.id, row.targetId), live)).get();
    if (!page) return [];
    if (!row.includeChildren) return [{ id: row.targetId, parentId: null }];
    notebookId = page.notebookId;
  }
  const all = db
    .select({ id: pages.id, parentId: pages.parentId })
    .from(pages)
    .where(and(eq(pages.notebookId, notebookId), live))
    .orderBy(asc(pages.sortOrder), asc(pages.createdAt))
    .all();
  const children = new Map<string | null, string[]>();
  for (const p of all) children.set(p.parentId, [...(children.get(p.parentId) ?? []), p.id]);
  const out: { id: string; parentId: string | null }[] = [];
  const visit = (id: string, parentId: string | null) => {
    out.push({ id, parentId });
    for (const child of children.get(id) ?? []) visit(child, id);
  };
  if (row.kind === 'page') visit(row.targetId, null);
  else {
    // Pages whose parent is trashed have no live parent: they count as top-level.
    const ids = new Set(all.map((p) => p.id));
    for (const p of all) if (p.parentId === null || !ids.has(p.parentId)) visit(p.id, null);
  }
  return out;
}

/** Attachment addresses in shared pages point at the share's own route instead. */
const rewriteAttachments = (content: string, token: string) =>
  content.replace(/\/api\/attachments\/([A-Za-z0-9_-]+)/g, `/api/public/shares/${token}/attachments/$1`);

/** /api/shares (session only): the owner's links. */
export function shareRoutes(db: Db, secrets: SecretBox) {
  const toShare = (row: ShareRow, target: { title: string; trashed: boolean }): Share => {
    const token = secrets.decrypt(row.token);
    return {
      id: row.id,
      kind: row.kind as Share['kind'],
      targetId: row.targetId,
      title: target.title,
      includeChildren: row.includeChildren,
      trashed: target.trashed,
      path: token ? sharePath(token) : null,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
      viewCount: row.viewCount,
      lastViewedAt: row.lastViewedAt,
    };
  };

  return new Hono<AppEnv>()
    .get('/', (c) => {
      const rows = db.select().from(shares).where(eq(shares.userId, c.var.user.id)).orderBy(asc(shares.createdAt)).all();
      const list: Share[] = [];
      for (const row of rows) {
        const target = targetOf(db, row);
        // Emptied from the trash: the link has nothing left to show.
        if (!target) db.delete(shares).where(eq(shares.id, row.id)).run();
        else list.push(toShare(row, target));
      }
      return c.json(list);
    })
    .post('/', async (c) => {
      const input = await readJson(c, shareCreateSchema);
      const userId = c.var.user.id;
      const target = targetOf(db, { ...input, userId });
      if (!target || target.trashed) throw notFound(input.kind === 'notebook' ? 'Notebook' : 'Page');
      const token = randomBytes(18).toString('base64url');
      const now = Date.now();
      const row: ShareRow = {
        id: newId(),
        userId,
        kind: input.kind,
        targetId: input.targetId,
        // A notebook link always shows all its pages.
        includeChildren: input.kind === 'page' && input.includeChildren,
        tokenHash: hashToken(token),
        token: secrets.encrypt(token),
        createdAt: now,
        expiresAt: input.expiresInDays ? now + input.expiresInDays * DAY_MS : null,
        viewCount: 0,
        lastViewedAt: null,
      };
      db.insert(shares).values(row).run();
      return c.json(toShare(row, target), 201);
    })
    .delete('/:id', (c) => {
      const deleted = db.delete(shares).where(and(eq(shares.id, c.req.param('id')), eq(shares.userId, c.var.user.id))).run();
      if (!deleted.changes) throw notFound('Link');
      return c.body(null, 204);
    });
}

/**
 * /api/public/shares/<token>: what a link shows, without signing in. Unknown, expired and
 * emptied links all answer 404, and wrong tokens are rate-limited per IP.
 */
export function publicShareRoutes(db: Db, dataDir: string) {
  const failures = new LoginLimiter(30);

  const resolve = (c: Context): { row: ShareRow; token: string } => {
    const key = clientIp(c);
    if (failures.isBlocked(key)) throw new HTTPException(429, { message: 'Too many wrong links, try again later' });
    const token = c.req.param('token') ?? '';
    const row = db.select().from(shares).where(eq(shares.tokenHash, hashToken(token))).get();
    if (!row || (row.expiresAt !== null && row.expiresAt < Date.now())) {
      failures.fail(key);
      throw new HTTPException(404, { message: 'This link does not work: it may have expired or been turned off.' });
    }
    return { row, token };
  };
  const notShared = () => new HTTPException(404, { message: 'There is nothing to see here any more.' });
  const headers = { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' };

  return new Hono()
    .get('/:token', (c) => {
      const { row, token } = resolve(c);
      const target = targetOf(db, row);
      const tree = sharedTree(db, row);
      if (!target || target.trashed || !tree.length) throw notShared();
      const rows = db
        .select({ id: pages.id, title: pages.title, content: pages.content, updatedAt: pages.updatedAt })
        .from(pages)
        .where(inArray(pages.id, tree.map((p) => p.id)))
        .all();
      const byId = new Map(rows.map((p) => [p.id, p]));
      const color =
        row.kind === 'notebook'
          ? (db.select({ color: notebooks.color }).from(notebooks).where(eq(notebooks.id, row.targetId)).get()?.color ?? null)
          : null;
      db.update(shares)
        .set({ viewCount: sql`${shares.viewCount} + 1`, lastViewedAt: Date.now() })
        .where(eq(shares.id, row.id))
        .run();
      const share: PublicShare = {
        kind: row.kind as PublicShare['kind'],
        title: target.title,
        color,
        startId: tree[0]!.id,
        pages: tree.map(({ id, parentId }) => {
          const p = byId.get(id)!;
          return { id, parentId, title: p.title, content: rewriteAttachments(p.content, token), updatedAt: p.updatedAt };
        }),
        expiresAt: row.expiresAt,
      };
      return c.json(share, 200, headers);
    })
    .get('/:token/attachments/:id/:filename?', (c) => {
      const { row } = resolve(c);
      const id = c.req.param('id');
      const ids = sharedTree(db, row).map((p) => p.id);
      // Only files a shared page links to, so the link cannot be used to fetch others.
      const linked =
        ids.length > 0 &&
        db
          .select({ id: pages.id })
          .from(pages)
          .where(and(inArray(pages.id, ids), sql`instr(${pages.content}, ${`/api/attachments/${id}`}) > 0`))
          .limit(1)
          .get() !== undefined;
      const file = linked ? db.select().from(attachments).where(and(eq(attachments.id, id), eq(attachments.userId, row.userId))).get() : undefined;
      if (!file) throw notFound('Attachment');
      const res = attachmentResponse(dataDir, file, 'private, max-age=3600', c.req.header('range'));
      res.headers.set('X-Robots-Tag', 'noindex, nofollow');
      return res;
    });
}
