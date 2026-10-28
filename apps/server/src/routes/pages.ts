import { and, asc, desc, eq, inArray, isNull, max, ne, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import {
  pageChangesSchema,
  pageCreateSchema,
  pageMoveSchema,
  pageTagsSchema,
  pageUpdateSchema,
  type ApiError,
  type Page,
  type PageMove,
  type PageSummary,
  type PageVersion,
  type PageVersionSummary,
  type RenameResult,
  type VersionReason,
} from '@nicotes/shared';
import type { AppEnv } from '../auth.js';
import type { Db } from '../db/index.js';
import { pages, pageVersions } from '../db/schema.js';
import { notFound, readJson } from '../http.js';
import { newId } from '../ids.js';
import { findBacklinks, indexPageLinks, propagateRenames, type Tx } from '../links.js';
import { getNotebook } from './notebooks.js';
import { snapshotPage } from '../versions.js';
import { setPageTags, tagsByPage } from './tags.js';
import { deletionTime } from './trash.js';

const summaryColumns = {
  id: pages.id,
  notebookId: pages.notebookId,
  parentId: pages.parentId,
  title: pages.title,
  sortOrder: pages.sortOrder,
  createdAt: pages.createdAt,
  updatedAt: pages.updatedAt,
};

const pageColumns = {
  ...summaryColumns,
  content: pages.content,
  version: pages.version,
};

const live = (userId: string) => and(eq(pages.userId, userId), isNull(pages.deletedAt));

export function findPage(db: Db | Tx, userId: string, id: string): Page {
  const row = db
    .select(pageColumns)
    .from(pages)
    .where(and(eq(pages.id, id), live(userId)))
    .get();
  if (!row) throw notFound('Page');
  return { ...row, tags: tagsByPage(db, userId, [id]).get(id) ?? [] };
}

/** Ids of all live descendants of `rootId` (excluding the root itself). */
export function descendantIds(db: Db | Tx, userId: string, rootId: string): string[] {
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

function findVersion(db: Db, pageId: string, versionId: string): PageVersion {
  const row = db
    .select()
    .from(pageVersions)
    .where(and(eq(pageVersions.id, versionId), eq(pageVersions.pageId, pageId)))
    .get();
  if (!row) throw notFound('Version');
  return {
    id: row.id,
    title: row.title,
    reason: row.reason as VersionReason,
    createdAt: row.createdAt,
    size: row.content.length,
    content: row.content,
  };
}

const siblingsOf = (notebookId: string, parentId: string | null) =>
  and(eq(pages.notebookId, notebookId), parentId ? eq(pages.parentId, parentId) : isNull(pages.parentId));


/**
 * Moves a page (with its subtree) to a new parent/notebook position and renumbers the
 * destination siblings. Validates against cycles. Callers wrap this in propagateRenames.
 */
export function applyMove(tx: Tx, userId: string, id: string, target: PageMove) {
  const page = findPage(tx, userId, id);
  getNotebook(tx, userId, target.notebookId);
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
}

/** Index of a page among its siblings (for restoring its position later). */
export function siblingIndex(db: Db | Tx, userId: string, page: { id: string; notebookId: string; parentId: string | null }) {
  const ids = db
    .select({ id: pages.id })
    .from(pages)
    .where(and(live(userId), siblingsOf(page.notebookId, page.parentId)))
    .orderBy(asc(pages.sortOrder), asc(pages.createdAt))
    .all()
    .map((r) => r.id);
  return Math.max(0, ids.indexOf(page.id));
}

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
      const tags = tagsByPage(db, c.var.user.id);
      return c.json(rows.map((row) => ({ ...row, tags: tags.get(row.id) ?? [] })) satisfies PageSummary[]);
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
      if (input.content) indexPageLinks(db, userId, id, input.content);
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
      const titleChanged = changes.title !== undefined && changes.title !== current.title;
      const relinked = db.transaction((tx) => {
        if (contentChanged) snapshotPage(tx, { ...current, userId }, 'edit');
        const apply = () => {
          tx.update(pages)
            .set({
              ...changes,
              version: contentChanged ? current.version + 1 : current.version,
              updatedAt: Date.now(),
            })
            .where(eq(pages.id, current.id))
            .run();
          if (contentChanged) indexPageLinks(tx, userId, current.id, changes.content!);
        };
        if (!titleChanged) return (apply(), []);
        return propagateRenames(tx, userId, apply).filter((id) => id !== current.id);
      });
      const result: Page & RenameResult = { ...findPage(db, userId, current.id), relinked };
      return c.json(result);
    })
    .get('/:id/versions', (c) => {
      const page = findPage(db, c.var.user.id, c.req.param('id'));
      const rows = db
        .select({
          id: pageVersions.id,
          title: pageVersions.title,
          reason: pageVersions.reason,
          createdAt: pageVersions.createdAt,
          size: sql<number>`length(${pageVersions.content})`,
        })
        .from(pageVersions)
        .where(eq(pageVersions.pageId, page.id))
        .orderBy(desc(pageVersions.createdAt))
        .all();
      return c.json(rows as PageVersionSummary[]);
    })
    .get('/:id/versions/:versionId', (c) => {
      const page = findPage(db, c.var.user.id, c.req.param('id'));
      return c.json(findVersion(db, page.id, c.req.param('versionId')));
    })
    .post('/:id/versions/:versionId/restore', (c) => {
      const userId = c.var.user.id;
      const page = findPage(db, userId, c.req.param('id'));
      const version = findVersion(db, page.id, c.req.param('versionId'));
      // Only the content is restored; the title stays, so links to the page keep working.
      db.transaction((tx) => {
        snapshotPage(tx, { ...page, userId }, 'restore', true);
        tx.update(pages)
          .set({ content: version.content, version: page.version + 1, updatedAt: Date.now() })
          .where(eq(pages.id, page.id))
          .run();
        indexPageLinks(tx, userId, page.id, version.content);
      });
      return c.json(findPage(db, userId, page.id));
    })
    // Content reviewed as a diff (accepted AI changes, a partial restore): the state before is
    // always kept as a version, so the change can be undone from the history.
    .post('/:id/changes', async (c) => {
      const { content, baseVersion, reason } = await readJson(c, pageChangesSchema);
      const userId = c.var.user.id;
      const current = findPage(db, userId, c.req.param('id'));
      if (current.version !== baseVersion) {
        return c.json({ error: 'The page was changed elsewhere', current } satisfies ApiError, 409);
      }
      if (content === current.content) return c.json(current);
      db.transaction((tx) => {
        snapshotPage(tx, { ...current, userId }, reason, true);
        tx.update(pages)
          .set({ content, version: current.version + 1, updatedAt: Date.now() })
          .where(eq(pages.id, current.id))
          .run();
        indexPageLinks(tx, userId, current.id, content);
      });
      return c.json(findPage(db, userId, current.id));
    })
    .get('/:id/backlinks', (c) => {
      const page = findPage(db, c.var.user.id, c.req.param('id'));
      return c.json(findBacklinks(db, c.var.user.id, page.id));
    })
    .put('/:id/tags', async (c) => {
      const { tags } = await readJson(c, pageTagsSchema);
      const userId = c.var.user.id;
      const page = findPage(db, userId, c.req.param('id'));
      db.transaction((tx) => setPageTags(tx, userId, page.id, tags));
      return c.json(findPage(db, userId, page.id));
    })
    .post('/:id/move', async (c) => {
      const target = await readJson(c, pageMoveSchema);
      const userId = c.var.user.id;
      const id = c.req.param('id');
      const relinked = db.transaction((tx) =>
        propagateRenames(tx, userId, () => applyMove(tx, userId, id, target)),
      );
      const result: Page & RenameResult = { ...findPage(db, userId, id), relinked };
      return c.json(result);
    })
    .delete('/:id', (c) => {
      const userId = c.var.user.id;
      const page = findPage(db, userId, c.req.param('id'));
      const ids = [page.id, ...descendantIds(db, userId, page.id)];
      // Same timestamp for the whole subtree so it can be restored as one unit later.
      db.update(pages).set({ deletedAt: deletionTime(db, userId) }).where(inArray(pages.id, ids)).run();
      return c.body(null, 204);
    });
}
