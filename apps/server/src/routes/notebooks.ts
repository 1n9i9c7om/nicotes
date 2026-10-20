import { and, asc, eq, isNull, max, ne } from 'drizzle-orm';
import { Hono } from 'hono';
import {
  notebookCreateSchema,
  notebookMoveSchema,
  notebookUpdateSchema,
  type Notebook,
  type RenameResult,
} from '@nicotes/shared';
import type { AppEnv } from '../auth.js';
import type { Db } from '../db/index.js';
import { notebooks, pages } from '../db/schema.js';
import { notFound, readJson } from '../http.js';
import { newId } from '../ids.js';
import { propagateRenames, type Tx } from '../links.js';
import { deletionTime } from './trash.js';

const columns = {
  id: notebooks.id,
  title: notebooks.title,
  icon: notebooks.icon,
  color: notebooks.color,
  sortOrder: notebooks.sortOrder,
  createdAt: notebooks.createdAt,
  updatedAt: notebooks.updatedAt,
};

export function getNotebook(db: Db | Tx, userId: string, id: string): Notebook {
  const row = db
    .select(columns)
    .from(notebooks)
    .where(and(eq(notebooks.id, id), eq(notebooks.userId, userId), isNull(notebooks.deletedAt)))
    .get();
  if (!row) throw notFound('Notebook');
  return row;
}

export function notebookRoutes(db: Db) {
  return new Hono<AppEnv>()
    .get('/', (c) => {
      const rows = db
        .select(columns)
        .from(notebooks)
        .where(and(eq(notebooks.userId, c.var.user.id), isNull(notebooks.deletedAt)))
        .orderBy(asc(notebooks.sortOrder), asc(notebooks.createdAt))
        .all();
      return c.json(rows satisfies Notebook[]);
    })
    .post('/', async (c) => {
      const input = await readJson(c, notebookCreateSchema);
      const userId = c.var.user.id;
      const last = db
        .select({ value: max(notebooks.sortOrder) })
        .from(notebooks)
        .where(and(eq(notebooks.userId, userId), isNull(notebooks.deletedAt)))
        .get();
      const now = Date.now();
      const row = {
        id: newId(),
        userId,
        title: input.title,
        icon: input.icon ?? null,
        color: input.color ?? null,
        sortOrder: (last?.value ?? -1) + 1,
        createdAt: now,
        updatedAt: now,
      };
      db.insert(notebooks).values(row).run();
      return c.json(getNotebook(db, userId, row.id), 201);
    })
    .patch('/:id', async (c) => {
      const input = await readJson(c, notebookUpdateSchema);
      const { id } = c.req.param();
      const userId = c.var.user.id;
      const current = getNotebook(db, userId, id);
      const relinked = db.transaction((tx) => {
        const apply = () =>
          tx.update(notebooks)
            .set({ ...input, updatedAt: Date.now() })
            .where(eq(notebooks.id, id))
            .run();
        // Qualified links like [[Games/Elden Ring]] contain the notebook title.
        if (input.title === undefined || input.title === current.title) return (apply(), []);
        return propagateRenames(tx, userId, apply);
      });
      const result: Notebook & RenameResult = { ...getNotebook(db, userId, id), relinked };
      return c.json(result);
    })
    .post('/:id/move', async (c) => {
      const { index } = await readJson(c, notebookMoveSchema);
      const { id } = c.req.param();
      const userId = c.var.user.id;
      getNotebook(db, userId, id);
      db.transaction((tx) => {
        const siblings = tx
          .select({ id: notebooks.id })
          .from(notebooks)
          .where(and(eq(notebooks.userId, userId), isNull(notebooks.deletedAt), ne(notebooks.id, id)))
          .orderBy(asc(notebooks.sortOrder), asc(notebooks.createdAt))
          .all()
          .map((r) => r.id);
        siblings.splice(Math.min(index, siblings.length), 0, id);
        siblings.forEach((siblingId, i) =>
          tx.update(notebooks).set({ sortOrder: i }).where(eq(notebooks.id, siblingId)).run(),
        );
      });
      return c.json(getNotebook(db, userId, id));
    })
    .delete('/:id', (c) => {
      const { id } = c.req.param();
      getNotebook(db, c.var.user.id, id);
      db.transaction((tx) => {
        const now = deletionTime(tx, c.var.user.id);
        tx.update(notebooks).set({ deletedAt: now }).where(eq(notebooks.id, id)).run();
        tx.update(pages)
          .set({ deletedAt: now })
          .where(and(eq(pages.notebookId, id), isNull(pages.deletedAt)))
          .run();
      });
      return c.body(null, 204);
    });
}
