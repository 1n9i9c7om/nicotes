import { and, eq, inArray } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { streamSSE } from 'hono/streaming';
import { askRequestSchema, TEMPLATE_TAG, type AskEvent, type AskSource } from '@nicotes/shared';
import type { AppEnv } from '../auth.js';
import type { Db } from '../db/index.js';
import { pages } from '../db/schema.js';
import { readJson } from '../http.js';
import { pageIdsWithTag } from '../routes/tags.js';
import type { SettingsStore } from '../settings.js';
import { chunkPage } from './chunks.js';
import { guessLanguage, languageName } from './language.js';
import { LlmError, streamChat } from './llm.js';
import type { SemanticIndex } from './semantic.js';

const MAX_PASSAGES = 10;
const PASSAGE_CHARS = 1500;
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
 * keywords (full-text search, then the passages with the most matching words).
 */
export async function retrieve(
  db: Db,
  index: SemanticIndex,
  userId: string,
  query: string,
): Promise<{ passages: RetrievedPassage[]; retrieval: 'semantic' | 'keyword' }> {
  const semantic = await index.passages(userId, query, MAX_PASSAGES, 3);
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
       ORDER BY bm25(pages_fts, 0.0, 8.0, 1.0)
       LIMIT ${KEYWORD_PAGES + 4}`,
    )
    .all({ match: words.map((w) => `"${w}"*`).join(' OR '), userId }) as { id: string; notebookId: string; title: string; content: string }[];
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
  return { retrieval: 'keyword', passages: passages.slice(0, MAX_PASSAGES) };
}

const SYSTEM = `You answer questions from the user's personal notes.
Use only the numbered notes provided with the question. After each statement, cite the notes it comes from, like [1] or [2][4].
If the notes do not contain the answer, say so in one sentence and do not make anything up; you may then add what the notes do say on the topic.
Write Markdown: short paragraphs, lists where they help, no headings unless the answer is long, no preamble.
Earlier answers in this conversation cite earlier notes; cite only the notes given with the current question.`;

export function askRoutes(db: Db, settings: SettingsStore, index: SemanticIndex) {
  return new Hono<AppEnv>().post('/ask', async (c) => {
    const input = await readJson(c, askRequestSchema);
    const userId = c.var.user.id;
    const cfg = settings.effective(userId);
    if (!cfg.openrouterApiKey) {
      throw new HTTPException(400, { message: 'Asking needs an OpenRouter API key — add one under Settings.' });
    }

    return streamSSE(c, async (stream) => {
      const controller = new AbortController();
      stream.onAbort(() => controller.abort());
      const send = (event: AskEvent) => stream.writeSSE({ data: JSON.stringify(event) });
      try {
        // Follow-up questions are often fragments ("and in winter?"): search with the previous one too.
        const previous = input.history.at(-1)?.question;
        const { passages, retrieval } = await retrieve(db, index, userId, previous ? `${previous}\n${input.question}` : input.question);
        const sources: AskSource[] = passages.map((p, i) => ({
          n: i + 1,
          pageId: p.pageId,
          notebookId: p.notebookId,
          title: p.title,
          heading: p.heading,
          excerpt: p.text.length > 280 ? `${p.text.slice(0, 277)}…` : p.text,
        }));
        await send({ type: 'sources', sources, retrieval });

        const notes = passages.length
          ? passages
              .map((p, i) => `[${i + 1}] ${p.title || 'Untitled'}${p.heading ? ` › ${p.heading}` : ''}\n${p.text.slice(0, PASSAGE_CHARS)}`)
              .join('\n\n---\n\n')
          : '(No matching notes were found.)';
        const language = guessLanguage(input.question);
        const system = `${SYSTEM}\nToday is ${new Date().toISOString().slice(0, 10)}.${language ? ` Answer in ${languageName(language)}.` : ' Answer in the language of the question.'}`;
        const { usage } = await streamChat(
          {
            apiKey: cfg.openrouterApiKey!,
            model: cfg.models.ask,
            maxTokens: 1500,
            signal: controller.signal,
            messages: [
              { role: 'system', content: system },
              ...input.history.flatMap((h) => [
                { role: 'user' as const, content: h.question },
                { role: 'assistant' as const, content: h.answer.slice(0, 3000) },
              ]),
              { role: 'user', content: `NOTES:\n\n${notes}\n\nQUESTION: ${input.question}` },
            ],
          },
          (text) => void send({ type: 'delta', text }),
        );
        await send({ type: 'done', cost: usage.cost, model: cfg.models.ask });
      } catch (error) {
        if (controller.signal.aborted) return;
        if (!(error instanceof LlmError)) console.error('Ask:', error);
        await send({ type: 'error', message: error instanceof LlmError ? error.message : 'Something went wrong while answering' });
      }
    });
  });
}
