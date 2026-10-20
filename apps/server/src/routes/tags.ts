import { and, asc, count, eq, inArray, isNull, notExists } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { tagUpdateSchema, type Tag } from '@nicotes/shared';
import type { AppEnv } from '../auth.js';
import type { Db } from '../db/index.js';
import { pages, pageTags, tags } from '../db/schema.js';
import { notFound, readJson } from '../http.js';
import { newId } from '../ids.js';
import type { Tx } from '../links.js';

type Conn = Db | Tx;

/** Tag names per page id for a user's pages (or the given pages). */
export function tagsByPage(db: Conn, userId: string, pageIds?: string[]): Map<string, string[]> {
  const rows = db
    .select({ pageId: pageTags.pageId, name: tags.name })
    .from(pageTags)
    .innerJoin(tags, eq(tags.id, pageTags.tagId))
    .where(and(eq(tags.userId, userId), pageIds ? inArray(pageTags.pageId, pageIds) : undefined))
    .orderBy(asc(tags.name))
    .all();
  const map = new Map<string, string[]>();
  for (const row of rows) {
    const list = map.get(row.pageId) ?? [];
    list.push(row.name);
    map.set(row.pageId, list);
  }
  return map;
}

/** Ids of the pages carrying a tag directly, e.g. templates. */
export function pageIdsWithTag(db: Conn, userId: string, name: string): Set<string> {
  const rows = db
    .select({ pageId: pageTags.pageId })
    .from(pageTags)
    .innerJoin(tags, eq(tags.id, pageTags.tagId))
    .where(and(eq(tags.userId, userId), eq(tags.name, name)))
    .all();
  return new Set(rows.map((r) => r.pageId));
}

/** Replaces a page's tags, creating new tags and dropping ones that became unused and empty. */
export function setPageTags(tx: Tx, userId: string, pageId: string, names: string[]) {
  const wanted = [...new Set(names)];
  const existing = wanted.length
    ? tx
        .select({ id: tags.id, name: tags.name })
        .from(tags)
        .where(and(eq(tags.userId, userId), inArray(tags.name, wanted)))
        .all()
    : [];
  const ids = new Map(existing.map((t) => [t.name, t.id]));
  for (const name of wanted) {
    if (ids.has(name)) continue;
    const id = newId();
    tx.insert(tags).values({ id, userId, name, createdAt: Date.now() }).run();
    ids.set(name, id);
  }
  tx.delete(pageTags).where(eq(pageTags.pageId, pageId)).run();
  if (wanted.length) {
    tx.insert(pageTags)
      .values(wanted.map((name) => ({ pageId, tagId: ids.get(name)! })))
      .run();
  }
  // Tags without pages and without a description are just noise.
  tx.delete(tags)
    .where(
      and(
        eq(tags.userId, userId),
        eq(tags.description, ''),
        notExists(tx.select().from(pageTags).where(eq(pageTags.tagId, tags.id))),
      ),
    )
    .run();
}

function findTag(db: Conn, userId: string, name: string) {
  const row = db
    .select()
    .from(tags)
    .where(and(eq(tags.userId, userId), eq(tags.name, name)))
    .get();
  if (!row) throw notFound('Tag');
  return row;
}

function listTags(db: Conn, userId: string): Tag[] {
  const counts = new Map(
    db
      .select({ tagId: pageTags.tagId, n: count() })
      .from(pageTags)
      .innerJoin(pages, eq(pages.id, pageTags.pageId))
      .where(and(eq(pages.userId, userId), isNull(pages.deletedAt)))
      .groupBy(pageTags.tagId)
      .all()
      .map((r) => [r.tagId, r.n]),
  );
  return db
    .select()
    .from(tags)
    .where(eq(tags.userId, userId))
    .orderBy(asc(tags.name))
    .all()
    .map((t) => ({
      name: t.name,
      description: t.description,
      color: t.color,
      inherit: t.inherit,
      count: counts.get(t.id) ?? 0,
    }));
}

export function tagRoutes(db: Db) {
  return new Hono<AppEnv>()
    .get('/', (c) => c.json(listTags(db, c.var.user.id)))
    .patch('/:name', async (c) => {
      const input = await readJson(c, tagUpdateSchema);
      const userId = c.var.user.id;
      const tag = findTag(db, userId, c.req.param('name'));
      if (input.name && input.name !== tag.name) {
        const clash = db
          .select({ id: tags.id })
          .from(tags)
          .where(and(eq(tags.userId, userId), eq(tags.name, input.name)))
          .get();
        if (clash) throw new HTTPException(409, { message: `Tag "${input.name}" already exists` });
      }
      db.update(tags).set(input).where(eq(tags.id, tag.id)).run();
      const updated = listTags(db, userId).find((t) => t.name === (input.name ?? tag.name));
      return c.json(updated);
    })
    .delete('/:name', (c) => {
      const tag = findTag(db, c.var.user.id, c.req.param('name'));
      db.delete(tags).where(eq(tags.id, tag.id)).run();
      return c.body(null, 204);
    });
}

/** Tags a page gets from ancestors via inheriting tags (excluding its own), per page id. */
export function inheritedTags(db: Conn, userId: string): Map<string, string[]> {
  const inheriting = new Set(
    db
      .select({ name: tags.name })
      .from(tags)
      .where(and(eq(tags.userId, userId), eq(tags.inherit, true)))
      .all()
      .map((t) => t.name),
  );
  const result = new Map<string, string[]>();
  if (!inheriting.size) return result;
  const own = tagsByPage(db, userId);
  const parents = new Map(
    db
      .select({ id: pages.id, parentId: pages.parentId })
      .from(pages)
      .where(and(eq(pages.userId, userId), isNull(pages.deletedAt)))
      .all()
      .map((p) => [p.id, p.parentId]),
  );
  for (const id of parents.keys()) {
    const found = new Set<string>();
    for (let cur = parents.get(id); cur; cur = parents.get(cur)) {
      for (const tag of own.get(cur) ?? []) if (inheriting.has(tag)) found.add(tag);
    }
    for (const tag of own.get(id) ?? []) found.delete(tag);
    if (found.size) result.set(id, [...found].sort());
  }
  return result;
}
