import { and, eq, inArray, isNotNull, isNull, lt, max } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { TRASH_RETENTION_DAYS, type TrashItem } from '@nicotes/shared';
import type { AppEnv } from '../auth.js';
import type { Db } from '../db/index.js';
import { notebooks, pages } from '../db/schema.js';
import { notFound, readJson } from '../http.js';
import type { Tx } from '../links.js';

/**
 * A deletion timestamp later than every existing one. Trash groups are identified by their
 * shared timestamp, so two deletions in the same millisecond must not collide.
 */
export function deletionTime(db: Db | Tx, userId: string): number {
  const p = db.select({ v: max(pages.deletedAt) }).from(pages).where(eq(pages.userId, userId)).get();
  const n = db.select({ v: max(notebooks.deletedAt) }).from(notebooks).where(eq(notebooks.userId, userId)).get();
  return Math.max(Date.now(), (p?.v ?? 0) + 1, (n?.v ?? 0) + 1);
}

type DeletedPage = { id: string; parentId: string | null; notebookId: string; title: string; deletedAt: number };

function deletedPages(db: Db | Tx, userId: string): DeletedPage[] {
  return db
    .select({
      id: pages.id,
      parentId: pages.parentId,
      notebookId: pages.notebookId,
      title: pages.title,
      deletedAt: pages.deletedAt,
    })
    .from(pages)
    .where(and(eq(pages.userId, userId), isNotNull(pages.deletedAt)))
    .all() as DeletedPage[];
}

/**
 * A page subtree is deleted with one shared timestamp. Its root is the page whose parent
 * was not deleted in the same operation; the rest belong to the root's trash entry.
 */
function groupOf(all: DeletedPage[], root: DeletedPage): string[] {
  const ids = [root.id];
  for (let i = 0; i < ids.length; i++) {
    for (const p of all) if (p.parentId === ids[i] && p.deletedAt === root.deletedAt) ids.push(p.id);
  }
  return ids;
}

function isGroupRoot(byId: Map<string, DeletedPage>, page: DeletedPage) {
  const parent = page.parentId ? byId.get(page.parentId) : undefined;
  return !parent || parent.deletedAt !== page.deletedAt;
}

export function listTrash(db: Db, userId: string): TrashItem[] {
  const deletedNotebooks = db
    .select({ id: notebooks.id, title: notebooks.title, deletedAt: notebooks.deletedAt })
    .from(notebooks)
    .where(and(eq(notebooks.userId, userId), isNotNull(notebooks.deletedAt)))
    .all();
  const liveNotebooks = new Map(
    db
      .select({ id: notebooks.id, title: notebooks.title })
      .from(notebooks)
      .where(and(eq(notebooks.userId, userId), isNull(notebooks.deletedAt)))
      .all()
      .map((n) => [n.id, n.title]),
  );
  const all = deletedPages(db, userId);
  const byId = new Map(all.map((p) => [p.id, p]));

  const items: TrashItem[] = deletedNotebooks.map((nb) => ({
    kind: 'notebook',
    id: nb.id,
    title: nb.title,
    notebookId: null,
    notebookTitle: null,
    deletedAt: nb.deletedAt!,
    pageCount: all.filter((p) => p.notebookId === nb.id && p.deletedAt === nb.deletedAt).length,
  }));
  // Pages of a deleted notebook are restored with it, so only list pages of live notebooks.
  for (const page of all) {
    if (!liveNotebooks.has(page.notebookId) || !isGroupRoot(byId, page)) continue;
    items.push({
      kind: 'page',
      id: page.id,
      title: page.title,
      notebookId: page.notebookId,
      notebookTitle: liveNotebooks.get(page.notebookId)!,
      deletedAt: page.deletedAt,
      pageCount: groupOf(all, page).length,
    });
  }
  return items.sort((a, b) => b.deletedAt - a.deletedAt);
}

function restorePage(tx: Tx, userId: string, id: string) {
  const all = deletedPages(tx, userId);
  const byId = new Map(all.map((p) => [p.id, p]));
  const root = byId.get(id);
  if (!root || !isGroupRoot(byId, root)) throw notFound('Trash item');
  const notebook = tx
    .select({ id: notebooks.id })
    .from(notebooks)
    .where(and(eq(notebooks.id, root.notebookId), isNull(notebooks.deletedAt)))
    .get();
  if (!notebook) throw notFound('Notebook');

  // Back under its old parent if that still exists, otherwise at the top level; last in line.
  const parent = root.parentId
    ? tx
        .select({ id: pages.id })
        .from(pages)
        .where(and(eq(pages.id, root.parentId), isNull(pages.deletedAt)))
        .get()
    : undefined;
  const parentId = parent?.id ?? null;
  const last = tx
    .select({ value: max(pages.sortOrder) })
    .from(pages)
    .where(
      and(
        eq(pages.notebookId, root.notebookId),
        parentId ? eq(pages.parentId, parentId) : isNull(pages.parentId),
        isNull(pages.deletedAt),
      ),
    )
    .get();
  tx.update(pages).set({ deletedAt: null }).where(inArray(pages.id, groupOf(all, root))).run();
  tx.update(pages)
    .set({ parentId, sortOrder: (last?.value ?? -1) + 1 })
    .where(eq(pages.id, root.id))
    .run();
}

function restoreNotebook(tx: Tx, userId: string, id: string) {
  const nb = tx
    .select({ deletedAt: notebooks.deletedAt })
    .from(notebooks)
    .where(and(eq(notebooks.id, id), eq(notebooks.userId, userId), isNotNull(notebooks.deletedAt)))
    .get();
  if (!nb) throw notFound('Trash item');
  tx.update(notebooks).set({ deletedAt: null }).where(eq(notebooks.id, id)).run();
  tx.update(pages)
    .set({ deletedAt: null })
    .where(and(eq(pages.notebookId, id), eq(pages.deletedAt, nb.deletedAt!)))
    .run();
}

/** Permanently removes trashed items older than the retention period. */
export function purgeTrash(db: Db, now = Date.now()) {
  const cutoff = now - TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  db.transaction((tx) => {
    tx.delete(pages).where(lt(pages.deletedAt, cutoff)).run();
    tx.delete(notebooks).where(lt(notebooks.deletedAt, cutoff)).run();
  });
}

const itemSchema = z.object({ kind: z.enum(['notebook', 'page']), id: z.string().min(1) });

export function trashRoutes(db: Db) {
  return new Hono<AppEnv>()
    .get('/', (c) => c.json(listTrash(db, c.var.user.id)))
    .post('/restore', async (c) => {
      const { kind, id } = await readJson(c, itemSchema);
      const userId = c.var.user.id;
      db.transaction((tx) => (kind === 'page' ? restorePage(tx, userId, id) : restoreNotebook(tx, userId, id)));
      return c.body(null, 204);
    })
    .delete('/:kind/:id', (c) => {
      const { kind, id } = itemSchema.parse(c.req.param());
      const userId = c.var.user.id;
      const item = listTrash(db, userId).find((i) => i.kind === kind && i.id === id);
      if (!item) throw notFound('Trash item');
      // Foreign keys cascade to subpages, versions, links and tags.
      if (kind === 'notebook') db.delete(notebooks).where(eq(notebooks.id, id)).run();
      else db.delete(pages).where(eq(pages.id, id)).run();
      return c.body(null, 204);
    })
    .delete('/', (c) => {
      const userId = c.var.user.id;
      db.transaction((tx) => {
        tx.delete(pages).where(and(eq(pages.userId, userId), isNotNull(pages.deletedAt))).run();
        tx.delete(notebooks).where(and(eq(notebooks.userId, userId), isNotNull(notebooks.deletedAt))).run();
      });
      return c.body(null, 204);
    });
}
