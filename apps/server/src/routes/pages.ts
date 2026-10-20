import { and, asc, eq, inArray, isNull, max, ne } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import {
  pageCreateSchema,
  pageMoveSchema,
  pageUpdateSchema,
  type ApiError,
  type Page,
  type PageSummary,
} from '@nicotes/shared';
import type { AppEnv } from '../auth.js';
import type { Db } from '../db/index.js';
import { pages } from '../db/schema.js';
import { notFound, readJson } from '../http.js';
import { newId } from '../ids.js';
import { getNotebook } from './notebooks.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

const summaryColumns = {
  id: pages.id,
  notebookId: pages.notebookId,
  parentId: pages.parentId,
  title: pages.title,
  sortOrder: pages.sortOrder,
  updatedAt: pages.updatedAt,
};

const pageColumns = {
  ...summaryColumns,
  content: pages.content,
  version: pages.version,
  createdAt: pages.createdAt,
};

const live = (userId: string) => and(eq(pages.userId, userId), isNull(pages.deletedAt));

function findPage(db: Db | Tx, userId: string, id: string): Page {
  const row = db
    .select(pageColumns)
    .from(pages)
    .where(and(eq(pages.id, id), live(userId)))
    .get();
  if (!row) throw notFound('Page');
  return row;
}

/** Ids of all live descendants of `rootId` (excluding the root itself). */
function descendantIds(db: Db | Tx, userId: string, rootId: string): string[] {
  const rows = db
    .select({ id: pages.id, parentId: pages.parentId })
    .from(pages)
    .where(live(userId))
    .all();
  const children = new Map<string, string[]>();
  for (const r of rows) {
    if (!r.parentId) continue;
    const list = children.get(r.parentId) ?? [];
    list.push(r.id);
    children.set(r.parentId, list);
  }
  const result: string[] = [];
  const queue = [rootId];
  while (queue.length) {
    for (const child of children.get(queue.shift()!) ?? []) {
      result.push(child);
      queue.push(child);
    }
  }
  return result;
}

const siblingsOf = (notebookId: string, parentId: string | null) =>
  and(eq(pages.notebookId, notebookId), parentId ? eq(pages.parentId, parentId) : isNull(pages.parentId));

export function pageRoutes(db: Db) {
  return new Hono<AppEnv>()
    .get('/', (c) => {
      const notebookId = c.req.query('notebookId');
      const rows = db
        .select(summaryColumns)
        .from(pages)
        .where(and(live(c.var.user.id), notebookId ? eq(pages.notebookId, notebookId) : undefined))
        .orderBy(asc(pages.sortOrder), asc(pages.createdAt))
        .all();
      return c.json(rows satisfies PageSummary[]);
    })
    .post('/', async (c) => {
      const input = await readJson(c, pageCreateSchema);
      const userId = c.var.user.id;
      getNotebook(db, userId, input.notebookId);
      const parentId = input.parentId ?? null;
      if (parentId && findPage(db, userId, parentId).notebookId !== input.notebookId) {
        throw new HTTPException(400, { message: 'Parent page belongs to another notebook' });
      }
      const last = db
        .select({ value: max(pages.sortOrder) })
        .from(pages)
        .where(and(live(userId), siblingsOf(input.notebookId, parentId)))
        .get();
      const now = Date.now();
      const id = newId();
      db.insert(pages)
        .values({
          id,
          userId,
          notebookId: input.notebookId,
          parentId,
          title: input.title ?? '',
          content: input.content ?? '',
          sortOrder: (last?.value ?? -1) + 1,
          createdAt: now,
          updatedAt: now,
        })
        .run();
      return c.json(findPage(db, userId, id), 201);
    })
    .get('/:id', (c) => c.json(findPage(db, c.var.user.id, c.req.param('id'))))
    .patch('/:id', async (c) => {
      const { baseVersion, ...changes } = await readJson(c, pageUpdateSchema);
      const userId = c.var.user.id;
      const current = findPage(db, userId, c.req.param('id'));
      const contentChanged = changes.content !== undefined;
      if (contentChanged && baseVersion === undefined) {
        throw new HTTPException(400, { message: 'baseVersion is required when changing content' });
      }
      if (contentChanged && current.version !== baseVersion) {
        return c.json({ error: 'The page was changed elsewhere', current } satisfies ApiError, 409);
      }
      db.update(pages)
        .set({
          ...changes,
          version: contentChanged ? current.version + 1 : current.version,
          updatedAt: Date.now(),
        })
        .where(eq(pages.id, current.id))
        .run();
      return c.json(findPage(db, userId, current.id));
    })
    .post('/:id/move', async (c) => {
      const target = await readJson(c, pageMoveSchema);
      const userId = c.var.user.id;
      const id = c.req.param('id');
      db.transaction((tx) => {
        const page = findPage(tx, userId, id);
        getNotebook(db, userId, target.notebookId);
        const descendants = descendantIds(tx, userId, id);
        if (target.parentId) {
          if (target.parentId === id || descendants.includes(target.parentId)) {
            throw new HTTPException(400, { message: 'A page cannot be moved into itself' });
          }
          if (findPage(tx, userId, target.parentId).notebookId !== target.notebookId) {
            throw new HTTPException(400, { message: 'Parent page belongs to another notebook' });
          }
        }
        if (page.notebookId !== target.notebookId && descendants.length) {
          tx.update(pages).set({ notebookId: target.notebookId }).where(inArray(pages.id, descendants)).run();
        }
        const siblings = tx
          .select({ id: pages.id })
          .from(pages)
          .where(and(live(userId), siblingsOf(target.notebookId, target.parentId), ne(pages.id, id)))
          .orderBy(asc(pages.sortOrder), asc(pages.createdAt))
          .all()
          .map((r) => r.id);
        siblings.splice(Math.min(target.index, siblings.length), 0, id);
        tx.update(pages)
          .set({ notebookId: target.notebookId, parentId: target.parentId })
          .where(eq(pages.id, id))
          .run();
        siblings.forEach((siblingId, i) =>
          tx.update(pages).set({ sortOrder: i }).where(eq(pages.id, siblingId)).run(),
        );
      });
      return c.json(findPage(db, userId, id));
    })
    .delete('/:id', (c) => {
      const userId = c.var.user.id;
      const page = findPage(db, userId, c.req.param('id'));
      const ids = [page.id, ...descendantIds(db, userId, page.id)];
      // Same timestamp for the whole subtree so it can be restored as one unit later.
      db.update(pages).set({ deletedAt: Date.now() }).where(inArray(pages.id, ids)).run();
      return c.body(null, 204);
    });
}
