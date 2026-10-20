import { and, eq, inArray, isNull } from 'drizzle-orm';
import {
  buildLinkContext,
  extractWikilinks,
  linkKey,
  linkTargetFor,
  mapWikilinks,
  pathOf,
  resolveWikilink,
  retarget,
  type Backlink,
  type LinkContext,
} from '@nicotes/shared';
import type { Db } from './db/index.js';
import { notebooks, pageLinks, pages } from './db/schema.js';
import { snapshotPage } from './versions.js';

export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Conn = Db | Tx;

/** Replaces the stored outgoing links of a page. */
export function indexPageLinks(db: Conn, userId: string, pageId: string, content: string) {
  db.delete(pageLinks).where(eq(pageLinks.sourceId, pageId)).run();
  const refs = extractWikilinks(content);
  if (refs.length === 0) return;
  db.insert(pageLinks)
    .values(refs.map((ref) => ({ sourceId: pageId, userId, target: ref.target, targetKey: linkKey(ref.target) })))
    .onConflictDoNothing()
    .run();
}

/** Rebuilds the link index for every page (cheap; run on startup so parser changes apply). */
export function reindexAllLinks(db: Db) {
  db.transaction((tx) => {
    tx.delete(pageLinks).run();
    for (const page of tx
      .select({ id: pages.id, userId: pages.userId, content: pages.content })
      .from(pages)
      .all()) {
      indexPageLinks(tx, page.userId, page.id, page.content);
    }
  });
}

export function loadLinkContext(db: Conn, userId: string): LinkContext {
  const pageRows = db
    .select({
      id: pages.id,
      notebookId: pages.notebookId,
      parentId: pages.parentId,
      title: pages.title,
      createdAt: pages.createdAt,
    })
    .from(pages)
    .where(and(eq(pages.userId, userId), isNull(pages.deletedAt)))
    .all();
  const notebookRows = db
    .select({ id: notebooks.id, title: notebooks.title })
    .from(notebooks)
    .where(and(eq(notebooks.userId, userId), isNull(notebooks.deletedAt)))
    .all();
  return buildLinkContext(pageRows, notebookRows);
}

/** All live link rows of a user together with their source page's notebook. */
function liveLinks(db: Conn, userId: string, keys?: string[]) {
  return db
    .select({
      sourceId: pageLinks.sourceId,
      target: pageLinks.target,
      notebookId: pages.notebookId,
    })
    .from(pageLinks)
    .innerJoin(pages, eq(pages.id, pageLinks.sourceId))
    .where(
      and(
        eq(pageLinks.userId, userId),
        isNull(pages.deletedAt),
        keys ? inArray(pageLinks.targetKey, keys) : undefined,
      ),
    )
    .all();
}

export function findBacklinks(db: Conn, userId: string, pageId: string): Backlink[] {
  const ctx = loadLinkContext(db, userId);
  const page = ctx.pages.get(pageId);
  if (!page) return [];
  const keys = [...new Set([page.title.trim().toLowerCase(), linkKey(page.title)])];
  const sources = new Map<string, string>(); // source id -> matching target
  for (const link of liveLinks(db, userId, keys)) {
    if (link.sourceId === pageId || sources.has(link.sourceId)) continue;
    if (resolveWikilink(ctx, link.target, link.notebookId)?.id === pageId) sources.set(link.sourceId, link.target);
  }
  if (sources.size === 0) return [];

  const rows = db
    .select({ id: pages.id, notebookId: pages.notebookId, title: pages.title, content: pages.content })
    .from(pages)
    .where(inArray(pages.id, [...sources.keys()]))
    .all();
  return rows
    .map((row) => ({
      id: row.id,
      notebookId: row.notebookId,
      title: row.title,
      excerpt: excerptAround(row.content, sources.get(row.id)!),
    }))
    .sort((a, b) => a.title.localeCompare(b.title));
}

function excerptAround(content: string, target: string): string {
  const needle = `[[${target}`.toLowerCase();
  const line = content.split('\n').find((l) => l.toLowerCase().includes(needle)) ?? '';
  const text = line.trim();
  return text.length > 240 ? `${text.slice(0, 237)}…` : text;
}

/**
 * Runs `mutate` (a rename or move) and rewrites every `[[link]]` whose target page's path
 * changed, so links keep pointing at the same page. Returns the ids of rewritten pages.
 */
export function propagateRenames(tx: Tx, userId: string, mutate: () => void): string[] {
  const before = loadLinkContext(tx, userId);
  const links = liveLinks(tx, userId).map((link) => ({
    ...link,
    resolved: resolveWikilink(before, link.target, link.notebookId)?.id ?? null,
  }));
  const beforePaths = new Map<string, string>();
  for (const link of links) {
    const page = link.resolved && before.pages.get(link.resolved);
    if (page && !beforePaths.has(page.id)) beforePaths.set(page.id, pathOf(before, page).join('\u0000'));
  }

  mutate();

  const after = loadLinkContext(tx, userId);
  const rewrites = new Map<string, Map<string, string>>(); // source id -> old target -> new target
  for (const link of links) {
    const page = link.resolved && after.pages.get(link.resolved);
    if (!page || pathOf(after, page).join('\u0000') === beforePaths.get(page.id)) continue;
    let next = retarget(after, page, link.target);
    if (next === null) continue;
    if (resolveWikilink(after, next, link.notebookId)?.id !== page.id) next = linkTargetFor(after, page);
    if (next === link.target) continue;
    const map = rewrites.get(link.sourceId) ?? new Map<string, string>();
    map.set(link.target, next);
    rewrites.set(link.sourceId, map);
  }
  if (rewrites.size === 0) return [];

  const sources = tx
    .select({ id: pages.id, title: pages.title, content: pages.content, version: pages.version })
    .from(pages)
    .where(inArray(pages.id, [...rewrites.keys()]))
    .all();
  for (const source of sources) {
    const map = rewrites.get(source.id)!;
    // Content changes the user did not type themselves are always undoable.
    snapshotPage(tx, { ...source, userId }, 'relink', true);
    const content = mapWikilinks(source.content, (ref) => map.get(ref.target) ?? null);
    tx.update(pages).set({ content, version: source.version + 1 }).where(eq(pages.id, source.id)).run();
    indexPageLinks(tx, userId, source.id, content);
  }
  return sources.map((s) => s.id);
}
