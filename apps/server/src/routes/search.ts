import { Hono } from 'hono';
import { normalizeTag, type SearchResult } from '@nicotes/shared';
import type { AttachmentReader } from '../attachmentText.js';
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

export function searchRoutes(db: Db, reader: AttachmentReader) {
  return new Hono<AppEnv>()
    .get('/attachments', (c) => c.json(reader.status(c.var.user.id)))
    .get('/', (c) => c.json(searchPages(db, c.var.user.id, c.req.query('q') ?? '', Math.min(Number(c.req.query('limit')) || 20, 50))));
}

/** Full-text search over pages and the files they show; `#tag` words filter by tag. */
export function searchPages(db: Db, userId: string, query: string, limit = 20): SearchResult[] {
  const { match, tagFilters } = parseQuery(query);
  if (!match && tagFilters.length === 0) return [];

  // Pages carrying the tag; for inheriting tags also all their (live) subpages.
  const tagSql = tagFilters
    .map(
      (_tag, i) => `AND p.id IN (
        WITH RECURSIVE tagged(id) AS (
          SELECT pt.page_id FROM page_tags pt JOIN tags t ON t.id = pt.tag_id
          WHERE t.user_id = @userId AND t.name = @tag${i}
          UNION
          SELECT c.id FROM pages c JOIN tagged ON c.parent_id = tagged.id
          WHERE c.deleted_at IS NULL
            AND EXISTS (SELECT 1 FROM tags t WHERE t.user_id = @userId AND t.name = @tag${i} AND t.inherit = 1)
        )
        SELECT id FROM tagged)`,
    )
    .join('\n');
  const tagParams = Object.fromEntries(tagFilters.map((tag, i) => [`tag${i}`, tag]));
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

  const params = { ...tagParams, ...(match ? { match } : {}), userId, limit };
  const rows = db.$client.prepare(sql).all(params) as SearchResult[];
  if (!match) return rows;

  // Matches in the files pages show: PDFs, text files, images read by AI, file names.
  const fileRows = db.$client
    .prepare(
      `SELECT p.id, p.notebook_id AS notebookId, p.title, a.id AS attachmentId, a.filename,
              snippet(attachments_fts, -1, char(1), char(2), '…', 16) AS excerpt
       FROM attachments_fts
       JOIN attachments a ON a.id = attachments_fts.attachment_id
       JOIN pages p ON p.user_id = a.user_id AND p.deleted_at IS NULL
         AND instr(p.content, '/api/attachments/' || a.id) > 0
       WHERE attachments_fts MATCH @match AND a.user_id = @userId
       ${tagSql}
       ORDER BY bm25(attachments_fts, 0.0, 4.0, 1.0)
       LIMIT @limit`,
    )
    .all(params) as (SearchResult & { attachmentId: string; filename: string })[];
  const seen = new Set(rows.map((r) => r.id));
  const files: SearchResult[] = [];
  for (const { attachmentId, filename, ...row } of fileRows) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    files.push({ ...row, attachment: { id: attachmentId, filename } });
  }
  // Pages matched by their own text come first; files keep at least a quarter of the places.
  const keep = Math.max(limit - Math.min(files.length, Math.ceil(limit / 4)), 0);
  return [...rows.slice(0, keep), ...files].slice(0, limit);
}
