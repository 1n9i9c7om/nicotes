import { Hono } from 'hono';
import { normalizeTag, type SearchResult } from '@nicotes/shared';
import type { AppEnv } from '../auth.js';
import type { Db } from '../db/index.js';

/**
 * Turns user input into an FTS5 query: every word becomes a quoted prefix term (so no FTS
 * syntax can leak through), `#tag` words become tag filters.
 */
export function parseQuery(input: string) {
  const terms: string[] = [];
  const tagFilters: string[] = [];
  for (const word of input.split(/\s+/)) {
    if (!word) continue;
    if (word.startsWith('#')) {
      const tag = normalizeTag(word);
      if (tag) tagFilters.push(tag);
      continue;
    }
    const clean = word.replace(/"/g, '');
    if (clean) terms.push(`"${clean}"*`);
  }
  return { match: terms.join(' '), tagFilters };
}

export function searchRoutes(db: Db) {
  return new Hono<AppEnv>().get('/', (c) => {
    const { match, tagFilters } = parseQuery(c.req.query('q') ?? '');
    const limit = Math.min(Number(c.req.query('limit')) || 20, 50);
    if (!match && tagFilters.length === 0) return c.json([]);

    const tagSql = tagFilters
      .map(
        () => `AND p.id IN (SELECT pt.page_id FROM page_tags pt JOIN tags t ON t.id = pt.tag_id
                            WHERE t.user_id = @userId AND t.name = ?)`,
      )
      .join('\n');
    const sql = match
      ? `SELECT p.id, p.notebook_id AS notebookId, p.title,
                snippet(pages_fts, 2, char(1), char(2), '…', 16) AS excerpt
         FROM pages_fts JOIN pages p ON p.id = pages_fts.page_id
         WHERE pages_fts MATCH @match AND p.user_id = @userId AND p.deleted_at IS NULL
         ${tagSql}
         ORDER BY bm25(pages_fts, 0.0, 8.0, 1.0)
         LIMIT @limit`
      : `SELECT p.id, p.notebook_id AS notebookId, p.title, '' AS excerpt
         FROM pages p
         WHERE p.user_id = @userId AND p.deleted_at IS NULL
         ${tagSql}
         ORDER BY p.updated_at DESC
         LIMIT @limit`;

    const rows = db.$client
      .prepare(sql)
      .all(...tagFilters, { match, userId: c.var.user.id, limit }) as SearchResult[];
    return c.json(rows);
  });
}
