import { and, eq, inArray } from 'drizzle-orm';
import { TEMPLATE_TAG } from '@nicotes/shared';
import type { Db } from '../db/index.js';
import { pages } from '../db/schema.js';
import { pageIdsWithTag } from '../routes/tags.js';
import { chunkPage } from './chunks.js';
import type { SemanticIndex } from './semantic.js';

const MAX_PASSAGES = 10;
const KEYWORD_PAGES = 6;

/** Words too common to be useful search terms (English and German). */
const STOPWORDS = new Set(
  (
    'the and for are was were has have had what which who whom whose when where why how does did doing can could ' +
    'should would will about with from into that this these those there their them they you your our not but all any ' +
    'der die das und oder ist sind war waren hat haben wie was wer wann warum welche welcher welches mit von für auf ' +
    'ein eine einen einem einer nicht auch noch nur sich ich du wir ihr sie mein meine dein im am zum zur des den dem'
  ).split(' '),
);

export interface RetrievedPassage {
  pageId: string;
  notebookId: string;
  title: string;
  heading: string;
  text: string;
}

/**
 * Finds the passages a question is about: by meaning when the semantic index is on, else by
 * keywords (full-text search, then the passages with the most matching words). `allowed`
 * limits the search to some pages (a read scope); null searches all of the user's pages.
 */
export async function retrieve(
  db: Db,
  index: SemanticIndex,
  userId: string,
  query: string,
  allowed: Set<string> | null = null,
  limit = MAX_PASSAGES,
): Promise<{ passages: RetrievedPassage[]; retrieval: 'semantic' | 'keyword' }> {
  const semantic = await index.passages(userId, query, limit, 3, undefined, allowed);
  if (semantic) {
    const ids = [...new Set(semantic.map((p) => p.pageId))];
    const info = new Map(
      ids.length
        ? db
            .select({ id: pages.id, title: pages.title, notebookId: pages.notebookId })
            .from(pages)
            .where(and(eq(pages.userId, userId), inArray(pages.id, ids)))
            .all()
            .map((p) => [p.id, p])
        : [],
    );
    return {
      retrieval: 'semantic',
      passages: semantic
        .filter((p) => info.has(p.pageId))
        .map((p) => ({ pageId: p.pageId, notebookId: info.get(p.pageId)!.notebookId, title: info.get(p.pageId)!.title, heading: p.heading, text: p.text })),
    };
  }

  const words = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [])].filter((w) => !STOPWORDS.has(w)).slice(0, 10);
  if (!words.length) return { retrieval: 'keyword', passages: [] };
  const rows = db.$client
    .prepare(
      `SELECT p.id, p.notebook_id AS notebookId, p.title, p.content
       FROM pages_fts f JOIN pages p ON p.id = f.page_id
       WHERE pages_fts MATCH @match AND p.user_id = @userId AND p.deleted_at IS NULL
         AND (@allowed IS NULL OR p.id IN (SELECT value FROM json_each(@allowed)))
       ORDER BY bm25(pages_fts, 0.0, 8.0, 1.0)
       LIMIT ${KEYWORD_PAGES + 4}`,
    )
    .all({ match: words.map((w) => `"${w}"*`).join(' OR '), userId, allowed: allowed ? JSON.stringify([...allowed]) : null }) as { id: string; notebookId: string; title: string; content: string }[];
  const templates = pageIdsWithTag(db, userId, TEMPLATE_TAG);
  const passages: RetrievedPassage[] = [];
  for (const row of rows.filter((r) => !templates.has(r.id)).slice(0, KEYWORD_PAGES)) {
    const chunks = chunkPage(row.content);
    const scored = chunks
      .map((c) => ({ c, hits: words.filter((w) => `${c.heading} ${c.text}`.toLowerCase().includes(w)).length }))
      .sort((a, b) => b.hits - a.hits);
    const best = scored.filter((s) => s.hits > 0).slice(0, 2);
    for (const { c } of best.length ? best : scored.slice(0, 1)) {
      passages.push({ pageId: row.id, notebookId: row.notebookId, title: row.title, heading: c.heading, text: c.text });
    }
  }
  return { retrieval: 'keyword', passages: passages.slice(0, limit) };
}
