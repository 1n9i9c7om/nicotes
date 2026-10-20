import { and, eq, inArray, isNull } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import {
  extractWikilinks,
  findPhrase,
  findMentions,
  mentionPattern,
  pathOf,
  preferredTarget,
  resolveWikilink,
  TEMPLATE_TAG,
  type AiLinkSuggestion,
  type AiLinkSuggestions,
  type PageSummaryInfo,
} from '@nicotes/shared';
import type { AppEnv } from '../auth.js';
import type { Db } from '../db/index.js';
import { pages, pageSummaries } from '../db/schema.js';
import { notFound } from '../http.js';
import { loadLinkContext } from '../links.js';
import { findPage } from '../routes/pages.js';
import { pageIdsWithTag } from '../routes/tags.js';
import type { AiConfig, SettingsStore } from '../settings.js';
import { plainText } from './chunks.js';
import { guessLanguage, languageName } from './language.js';
import { chat, completeJson, LlmError } from './llm.js';
import type { SemanticIndex } from './semantic.js';

const SUMMARY_INPUT_CHARS = 12_000;
const LINK_INPUT_CHARS = 8_000;
const MAX_CANDIDATES = 120;
const MAX_LINK_SUGGESTIONS = 8;

function requireKey(cfg: AiConfig) {
  if (!cfg.openrouterApiKey) throw new HTTPException(400, { message: 'This needs an OpenRouter API key — add one under Settings.' });
  return cfg.openrouterApiKey;
}

/** LLM failures are the upstream's fault, not ours: 502 with the readable message. */
async function upstream<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof LlmError) throw new HTTPException(502, { message: error.message });
    throw error;
  }
}

function summaryInfo(db: Db, userId: string, pageId: string): PageSummaryInfo | null {
  const row = db
    .select({ summary: pageSummaries.summary, version: pageSummaries.version, model: pageSummaries.model, cost: pageSummaries.cost, createdAt: pageSummaries.createdAt, current: pages.version })
    .from(pageSummaries)
    .innerJoin(pages, eq(pages.id, pageSummaries.pageId))
    .where(and(eq(pageSummaries.pageId, pageId), eq(pageSummaries.userId, userId), isNull(pages.deletedAt)))
    .get();
  return row ? { summary: row.summary, stale: row.version !== row.current, model: row.model, cost: row.cost, createdAt: row.createdAt } : null;
}

async function summarize(db: Db, cfg: AiConfig, userId: string, pageId: string): Promise<PageSummaryInfo> {
  const page = findPage(db, userId, pageId);
  const text = plainText(page.content).replace(/\n{3,}/g, '\n\n').trim();
  if (text.length < 80) throw new HTTPException(400, { message: 'This page is too short to summarize' });
  const language = guessLanguage(text.slice(0, 4000));
  const reply = await upstream(() =>
    chat({
      apiKey: requireKey(cfg),
      model: cfg.models.summary,
      maxTokens: 400,
      messages: [
        {
          role: 'system',
          content: `You summarize notes for someone scanning their own knowledge base. Write one to three sentences, at most 60 words, saying what the note is about and its key points. Plain text: no Markdown, no lists, no preamble like "This note". Write in ${language ? languageName(language) : 'the language of the note'}.`,
        },
        { role: 'user', content: `TITLE: ${page.title || 'Untitled'}\n\n${text.slice(0, SUMMARY_INPUT_CHARS)}` },
      ],
    }),
  );
  const summary = reply.content.replace(/\s+/g, ' ').replace(/^["“]|["”]$/g, '').trim();
  if (!summary) throw new HTTPException(502, { message: 'The model returned an empty summary, please try again' });
  const now = Date.now();
  const values = { summary, version: page.version, model: cfg.models.summary, cost: reply.usage.cost, createdAt: now };
  db.insert(pageSummaries)
    .values({ pageId, userId, ...values })
    .onConflictDoUpdate({ target: pageSummaries.pageId, set: values })
    .run();
  return { summary, stale: false, model: cfg.models.summary, cost: reply.usage.cost, createdAt: now };
}

const linkReplySchema = z.object({
  links: z
    .array(z.object({ phrase: z.string(), page: z.string(), reason: z.string().default('') }))
    .nullish()
    .transform((v) => v ?? []),
});

/**
 * Asks the model where a page should link to other pages. Candidates are the pages closest in
 * meaning (with the semantic index) or the most recently edited ones, plus pages it names;
 * every suggestion is checked against the text before it is returned.
 */
async function suggestLinks(db: Db, index: SemanticIndex, cfg: AiConfig, userId: string, pageId: string): Promise<AiLinkSuggestions> {
  const page = findPage(db, userId, pageId);
  if (plainText(page.content).trim().length < 40) throw new HTTPException(400, { message: 'This page has too little text to link from' });
  const ctx = loadLinkContext(db, userId);
  const linked = new Set(
    extractWikilinks(page.content)
      .map((ref) => resolveWikilink(ctx, ref.target, page.notebookId)?.id)
      .filter((id): id is string => !!id),
  );
  const exclude = new Set([pageId, ...linked, ...pageIdsWithTag(db, userId, TEMPLATE_TAG)]);

  const named = [...ctx.pages.values()].filter((p) => !exclude.has(p.id));
  const mentioned = findMentions(page.content, named.map((p) => mentionPattern(p.title)))
    .map((found, i) => (found.length ? named[i]!.id : null))
    .filter((id): id is string => !!id);
  const nearest =
    index.nearestPages(userId, pageId, exclude, MAX_CANDIDATES) ??
    db
      .select({ id: pages.id })
      .from(pages)
      .where(and(eq(pages.userId, userId), isNull(pages.deletedAt)))
      .all()
      .map((r) => r.id)
      .filter((id) => !exclude.has(id) && ctx.pages.has(id))
      .sort((a, b) => (ctx.pages.get(b)!.createdAt ?? 0) - (ctx.pages.get(a)!.createdAt ?? 0))
      .slice(0, MAX_CANDIDATES);
  const candidates = [...new Set([...mentioned, ...nearest])].slice(0, MAX_CANDIDATES);
  if (!candidates.length) return { suggestions: [], cost: 0 };

  const first = new Map(
    db
      .select({ id: pages.id, content: pages.content })
      .from(pages)
      .where(inArray(pages.id, candidates))
      .all()
      .map((r) => [r.id, plainText(r.content).replace(/\s+/g, ' ').trim().slice(0, 120)]),
  );
  const short = new Map(candidates.map((id, i) => [`c${i + 1}`, id]));
  const list = candidates
    .map((id, i) => `c${i + 1} | ${pathOf(ctx, ctx.pages.get(id)!).join(' / ')} | ${first.get(id) || '(empty)'}`)
    .join('\n');
  const language = guessLanguage(page.content.slice(0, 4000));

  const reply = await upstream(() =>
    completeJson({
      apiKey: requireKey(cfg),
      model: cfg.models.links,
      schema: linkReplySchema,
      maxTokens: 1500,
      system: `You help connect notes in a personal knowledge base by suggesting links. Reply with one JSON object only.`,
      user: `Suggest up to ${MAX_LINK_SUGGESTIONS} places where the NOTE should link to one of the CANDIDATE pages, only where a reader would really benefit.
For each link give "phrase": words copied exactly from the note (1 to 6 words, not inside existing [[links]], code or headings) that should become the link, "page": the candidate id, and "reason": one short sentence${language ? ` in ${languageName(language)}` : ''}.
Link each candidate at most once. An empty list is a good answer.
Reply as {"links":[{"phrase":"…","page":"c1","reason":"…"}]}

CANDIDATES (id | path | beginning):
${list}

NOTE "${page.title || 'Untitled'}":
${page.content.slice(0, LINK_INPUT_CHARS)}`,
    }),
  );

  const suggestions: AiLinkSuggestion[] = [];
  const used = new Set<string>();
  for (const link of reply.data.links) {
    const id = short.get(link.page.trim());
    const target = id && ctx.pages.get(id);
    if (!target || used.has(target.id)) continue;
    const found = findPhrase(page.content, link.phrase);
    if (!found) continue;
    used.add(target.id);
    suggestions.push({
      phrase: found.text,
      pageId: target.id,
      title: target.title,
      target: preferredTarget(ctx, target, page.notebookId),
      reason: link.reason.trim(),
    });
    if (suggestions.length >= MAX_LINK_SUGGESTIONS) break;
  }
  return { suggestions, cost: reply.usage.cost };
}

export function insightRoutes(db: Db, settings: SettingsStore, index: SemanticIndex) {
  return new Hono<AppEnv>()
    .get('/summary/:pageId', (c) => {
      findPage(db, c.var.user.id, c.req.param('pageId'));
      return c.json(summaryInfo(db, c.var.user.id, c.req.param('pageId')));
    })
    .post('/summary/:pageId', async (c) =>
      c.json(await summarize(db, settings.effective(c.var.user.id), c.var.user.id, c.req.param('pageId'))),
    )
    .delete('/summary/:pageId', (c) => {
      const deleted = db
        .delete(pageSummaries)
        .where(and(eq(pageSummaries.pageId, c.req.param('pageId')), eq(pageSummaries.userId, c.var.user.id)))
        .run();
      if (!deleted.changes) throw notFound('Summary');
      return c.body(null, 204);
    })
    .post('/link-suggestions/:pageId', async (c) =>
      c.json(await suggestLinks(db, index, settings.effective(c.var.user.id), c.var.user.id, c.req.param('pageId'))),
    );
}
