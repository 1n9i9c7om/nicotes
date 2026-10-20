import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import {
  extractWikilinks,
  findMentions,
  linkMention,
  MATCH_END,
  MATCH_START,
  mentionPattern,
  preferredTarget,
  resolveWikilink,
  TEMPLATE_TAG,
  type IncomingMention,
  type LinkablePage,
  type MentionsResult,
  type OutgoingMention,
  type RenameResult,
} from '@nicotes/shared';
import type { AppEnv } from '../auth.js';
import type { Db } from '../db/index.js';
import { pages } from '../db/schema.js';
import { notFound, readJson } from '../http.js';
import { findBacklinks, indexPageLinks, loadLinkContext, type Tx } from '../links.js';
import { snapshotPage } from '../versions.js';
import { pageIdsWithTag } from './tags.js';

type Conn = Db | Tx;
const MAX_INCOMING = 30;
const FTS_CANDIDATES = 300;

const templateIds = (db: Conn, userId: string) => pageIdsWithTag(db, userId, TEMPLATE_TAG);


function excerptAt(content: string, start: number, end: number): string {
  const lineStart = content.lastIndexOf('\n', start - 1) + 1;
  const lineEnd = content.indexOf('\n', end);
  const line = content.slice(lineStart, lineEnd < 0 ? undefined : lineEnd);
  const at = start - lineStart;
  const len = end - start;
  // Keep the excerpt short but centred on the mention.
  const from = Math.max(0, at - 100);
  const to = Math.min(line.length, at + len + 120);
  return (
    (from > 0 ? '…' : '') +
    line.slice(from, at) +
    MATCH_START +
    line.slice(at, at + len) +
    MATCH_END +
    line.slice(at + len, to) +
    (to < line.length ? '…' : '')
  ).trim();
}

/** Pages whose text names this page without linking it (pages that link it already are left out). */
export function incomingMentions(db: Db, userId: string, pageId: string, ctx = loadLinkContext(db, userId)): IncomingMention[] {
  const target = ctx.pages.get(pageId);
  if (!target) throw notFound('Page');
  const pattern = mentionPattern(target.title);
  const templates = templateIds(db, userId);
  if (!pattern || templates.has(pageId)) return [];
  const linkedFrom = new Set(findBacklinks(db, userId, pageId).map((b) => b.id));

  // Full-text search narrows the candidates; the exact rules are applied below.
  const rows = db.$client
    .prepare(
      `SELECT p.id, p.notebook_id AS notebookId, p.title, p.content
       FROM pages_fts f JOIN pages p ON p.id = f.page_id
       WHERE pages_fts MATCH @match AND p.user_id = @userId AND p.deleted_at IS NULL AND p.id != @pageId
       LIMIT ${FTS_CANDIDATES}`,
    )
    .all({ match: `content : "${pattern.words.join(' ')}"`, userId, pageId }) as {
    id: string;
    notebookId: string;
    title: string;
    content: string;
  }[];

  const result: IncomingMention[] = [];
  for (const row of rows) {
    if (linkedFrom.has(row.id) || templates.has(row.id)) continue;
    const found = findMentions(row.content, [pattern])[0]!;
    if (!found.length) continue;
    result.push({
      id: row.id,
      notebookId: row.notebookId,
      title: row.title,
      count: found.length,
      excerpt: excerptAt(row.content, found[0]!.start, found[0]!.end),
    });
  }
  return result.sort((a, b) => b.count - a.count || a.title.localeCompare(b.title)).slice(0, MAX_INCOMING);
}

/** Other pages this page names without linking them. Empty pages make no useful targets. */
export function outgoingMentions(db: Conn, userId: string, pageId: string, ctx = loadLinkContext(db, userId)): OutgoingMention[] {
  const page = db
    .select({ content: pages.content, notebookId: pages.notebookId })
    .from(pages)
    .where(and(eq(pages.id, pageId), eq(pages.userId, userId), isNull(pages.deletedAt)))
    .get();
  if (!page) throw notFound('Page');
  const templates = templateIds(db, userId);
  const linked = new Set(
    extractWikilinks(page.content)
      .map((ref) => resolveWikilink(ctx, ref.target, page.notebookId)?.id)
      .filter(Boolean),
  );
  const withContent = new Set(
    db
      .select({ id: pages.id })
      .from(pages)
      .where(and(eq(pages.userId, userId), isNull(pages.deletedAt), sql`length(trim(${pages.content})) > 0`))
      .all()
      .map((r) => r.id),
  );

  // Pages sharing a title share a pattern; the one a bare link would open wins.
  const groups = new Map<string, LinkablePage>();
  for (const p of ctx.pages.values()) {
    if (p.id === pageId || templates.has(p.id) || linked.has(p.id) || !withContent.has(p.id)) continue;
    const key = p.title.trim().toLowerCase();
    if (!key || groups.has(key)) continue;
    const chosen = resolveWikilink(ctx, p.title.trim(), page.notebookId);
    if (chosen && !linked.has(chosen.id) && chosen.id !== pageId && withContent.has(chosen.id)) groups.set(key, chosen);
  }
  const candidates = [...groups.values()];
  const found = findMentions(
    page.content,
    candidates.map((p) => mentionPattern(p.title)),
  );
  return candidates
    .map((p, i) => ({ page: p, mentions: found[i]! }))
    .filter((c) => c.mentions.length)
    .map(({ page: p, mentions }) => ({
      id: p.id,
      notebookId: p.notebookId,
      title: p.title,
      target: preferredTarget(ctx, p, page.notebookId),
      text: mentions[0]!.text,
      count: mentions.length,
    }))
    .sort((a, b) => b.count - a.count || a.title.localeCompare(b.title));
}

/**
 * Links the first unlinked mention of `pageId` in each source page. Returns the ids of pages
 * that changed (their old text is kept as a version).
 */
export function linkIncoming(tx: Tx, userId: string, pageId: string, sourceIds: string[]): string[] {
  const ctx = loadLinkContext(tx, userId);
  const target = ctx.pages.get(pageId);
  if (!target) throw notFound('Page');
  const pattern = mentionPattern(target.title);
  if (!pattern || !sourceIds.length) return [];
  const sources = tx
    .select({ id: pages.id, notebookId: pages.notebookId, title: pages.title, content: pages.content, version: pages.version })
    .from(pages)
    .where(and(inArray(pages.id, sourceIds), eq(pages.userId, userId), isNull(pages.deletedAt)))
    .all();
  const changed: string[] = [];
  for (const source of sources) {
    if (source.id === pageId) continue;
    const first = findMentions(source.content, [pattern])[0]![0];
    if (!first) continue;
    const content = linkMention(source.content, first, preferredTarget(ctx, target, source.notebookId));
    snapshotPage(tx, { ...source, userId }, 'relink', true);
    tx.update(pages)
      .set({ content, version: source.version + 1, updatedAt: Date.now() })
      .where(eq(pages.id, source.id))
      .run();
    indexPageLinks(tx, userId, source.id, content);
    changed.push(source.id);
  }
  return changed;
}

export function mentionRoutes(db: Db) {
  return new Hono<AppEnv>()
    .get('/:id/mentions', (c) => {
      const userId = c.var.user.id;
      const id = c.req.param('id');
      const ctx = loadLinkContext(db, userId);
      const result: MentionsResult = {
        incoming: incomingMentions(db, userId, id, ctx),
        outgoing: outgoingMentions(db, userId, id, ctx),
      };
      return c.json(result);
    })
    .post('/:id/mentions/link', async (c) => {
      const { sourceIds } = await readJson(c, z.object({ sourceIds: z.array(z.string().max(64)).min(1).max(100) }));
      const relinked = db.transaction((tx) => linkIncoming(tx, c.var.user.id, c.req.param('id'), sourceIds));
      return c.json({ relinked } satisfies RenameResult);
    });
}
