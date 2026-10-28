import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { ReadScope } from '@nicotes/shared';
import type { Db } from '../db/index.js';
import { pages } from '../db/schema.js';

interface ScopePage {
  id: string;
  notebookId: string;
  parentId: string | null;
}

/**
 * The pages an AI feature may read for `scope`, besides the open page itself (never included).
 * `null` means all of the user's pages.
 */
export function scopePageIds(db: Db, userId: string, page: ScopePage, scope: ReadScope): Set<string> | null {
  if (scope === 'all') return null;
  if (scope === 'page') return new Set();
  const rows = db
    .select({ id: pages.id, parentId: pages.parentId })
    .from(pages)
    .where(and(eq(pages.userId, userId), eq(pages.notebookId, page.notebookId), isNull(pages.deletedAt)))
    .all();
  let ids = rows.map((r) => r.id);
  if (scope === 'section') {
    // The parent page and everything under it; a top-level page is its own section.
    const root = page.parentId ?? page.id;
    const children = new Map<string, string[]>();
    for (const r of rows) if (r.parentId) children.set(r.parentId, [...(children.get(r.parentId) ?? []), r.id]);
    ids = [];
    const queue = [root];
    while (queue.length) {
      const id = queue.shift()!;
      ids.push(id);
      queue.push(...(children.get(id) ?? []));
    }
  }
  return new Set(ids.filter((id) => id !== page.id));
}

/** All pages of the given notebooks (for "Ask" limited to some notebooks). */
export function notebookPageIds(db: Db, userId: string, notebookIds: string[]): Set<string> {
  if (!notebookIds.length) return new Set();
  const rows = db
    .select({ id: pages.id })
    .from(pages)
    .where(and(eq(pages.userId, userId), inArray(pages.notebookId, notebookIds), isNull(pages.deletedAt)))
    .all();
  return new Set(rows.map((r) => r.id));
}
