import { createHash } from 'node:crypto';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import {
  extractWikilinks,
  resolveWikilink,
  TEMPLATE_TAG,
  type SemanticHit,
  type SemanticResults,
  type SemanticStatus,
} from '@nicotes/shared';
import type { AppEnv } from '../auth.js';
import type { Db } from '../db/index.js';
import { pageChunks, pageIndex, pages, users } from '../db/schema.js';
import { notFound } from '../http.js';
import { findBacklinks, loadLinkContext } from '../links.js';
import { pageIdsWithTag } from '../routes/tags.js';
import type { AiConfig, SettingsStore } from '../settings.js';
import { chunkPage, embeddingInput } from './chunks.js';
import { dot, embed as openRouterEmbed, EMBED_BATCH, fromBlob, toBlob, type Embedder } from './embeddings.js';
import { LlmError } from './llm.js';

const TICK_MS = 20_000;
/** Pages being edited wait until typing has paused this long. */
const QUIET_MS = 30_000;
const PAGES_PER_TICK = 40;
const ERROR_BACKOFF_MS = 5 * 60_000;
const QUERY_CACHE = 200;
/**
 * Result cut-offs (cosine similarity): an absolute floor below which matches are noise for
 * typical embedding models, and a spread: results far below the best one are dropped too.
 */
const SEARCH_CUTOFF = { floor: 0.3, spread: 0.2 };
const RELATED_CUTOFF = { floor: 0.35, spread: 0.15 };
/** Retrieval for answering questions is more generous: the model decides what is relevant. */
export const RETRIEVAL_CUTOFF = { floor: 0.2, spread: 0.25 };

type Cutoff = { floor: number; spread: number };
const cut = <T extends { score: number }>(sorted: T[], { floor, spread }: Cutoff) =>
  sorted.filter((s) => s.score >= Math.max(floor, (sorted[0]?.score ?? 0) - spread));

const sha1 = (s: string) => createHash('sha1').update(s).digest('hex');

/** A user's vectors in memory, one row per passage, for brute-force similarity search. */
interface VectorCache {
  model: string;
  dims: number;
  chunkIds: number[];
  /** Page id per passage. */
  pageOf: string[];
  /** All passage vectors back to back. */
  vectors: Float32Array;
  /** Normalised mean vector per page. */
  pageVectors: Map<string, Float32Array>;
  /** Passage indexes per page. */
  passages: Map<string, number[]>;
}

export interface Passage {
  chunkId: number;
  pageId: string;
  heading: string;
  text: string;
  score: number;
}

/**
 * The semantic index (opt-in per user): embeds changed pages in the background via OpenRouter,
 * keeps the vectors in SQLite and answers similarity queries from an in-memory copy. A personal
 * knowledge base has thousands of passages at most, so a linear scan is plenty fast.
 */
export class SemanticIndex {
  private cache = new Map<string, VectorCache>();
  private errors = new Map<string, { message: string; at: number }>();
  private queries = new Map<string, Float32Array>();
  private running: Promise<void> | null = null;
  private timer?: ReturnType<typeof setInterval>;
  private soon?: ReturnType<typeof setTimeout>;

  constructor(
    private db: Db,
    private settings: SettingsStore,
    private embedder: Embedder = openRouterEmbed,
    private quietMs = QUIET_MS,
  ) {}

  start() {
    this.timer = setInterval(() => void this.run(), TICK_MS);
    this.timer.unref?.();
    this.poke();
  }

  stop() {
    clearInterval(this.timer);
    clearTimeout(this.soon);
  }

  /** Runs soon, e.g. after the index was switched on. */
  poke(delay = 2000) {
    clearTimeout(this.soon);
    this.soon = setTimeout(() => void this.run(), delay);
    this.soon.unref?.();
  }

  /** Indexes stale pages of every user once; concurrent calls share the run. */
  run(): Promise<void> {
    this.running ??= this.indexAll().finally(() => (this.running = null));
    return this.running;
  }

  private async indexAll() {
    for (const { id } of this.db.select({ id: users.id }).from(users).all()) {
      const failed = this.errors.get(id);
      if (failed && Date.now() - failed.at < ERROR_BACKOFF_MS) continue;
      try {
        await this.indexUser(id);
        this.errors.delete(id);
      } catch (error) {
        this.errors.set(id, { message: (error as Error).message, at: Date.now() });
        if (!(error instanceof LlmError)) console.error('Semantic index:', error);
      }
    }
  }

  private async indexUser(userId: string) {
    const cfg = this.settings.effective(userId);
    if (!cfg.semanticIndex || !cfg.openrouterApiKey) return;
    const model = cfg.embeddingModel;
    const stale = this.db.$client
      .prepare(
        `SELECT p.id, p.title, p.content, p.version FROM pages p
         LEFT JOIN page_index i ON i.page_id = p.id
         WHERE p.user_id = @userId AND p.deleted_at IS NULL AND p.updated_at <= @quiet
           AND (i.page_id IS NULL OR i.version != p.version OR i.title != p.title OR i.model != @model)
         ORDER BY p.updated_at DESC LIMIT ${PAGES_PER_TICK}`,
      )
      .all({ userId, model, quiet: Date.now() - this.quietMs }) as { id: string; title: string; content: string; version: number }[];
    if (!stale.length) return;

    // Templates are scaffolding, not knowledge: recorded as indexed, without passages.
    const templates = pageIdsWithTag(this.db, userId, TEMPLATE_TAG);
    const plans = stale.map((page) => {
      const chunks = chunkPage(page.content);
      // An empty page is still findable (and relatable) by its title.
      const parts = chunks.length ? chunks : page.title.trim() ? [{ ord: 0, heading: '', text: '' }] : [];
      const items = templates.has(page.id)
        ? []
        : parts.map((c) => {
            const input = embeddingInput(page.title, c);
            return { ...c, input, hash: sha1(`${model}\u0000${input}`) };
          });
      return { page, items };
    });

    // Unchanged passages keep their vectors; only new text is embedded.
    const known = new Map<string, Buffer>();
    for (const row of this.db
      .select({ hash: pageChunks.hash, vector: pageChunks.vector })
      .from(pageChunks)
      .where(inArray(pageChunks.pageId, stale.map((p) => p.id)))
      .all()) {
      known.set(row.hash, row.vector);
    }
    const inputOf = new Map(plans.flatMap((p) => p.items.map((i) => [i.hash, i.input] as const)));
    const missing = [...inputOf.keys()].filter((h) => !known.has(h));
    const costOf = new Map<string, number>();
    let failure: unknown = null;
    for (let i = 0; i < missing.length; i += EMBED_BATCH) {
      const batch = missing.slice(i, i + EMBED_BATCH);
      try {
        const { vectors, usage } = await this.embedder({ apiKey: cfg.openrouterApiKey, model, inputs: batch.map((h) => inputOf.get(h)!) });
        batch.forEach((h, j) => {
          known.set(h, toBlob(vectors[j]!));
          costOf.set(h, usage.cost / batch.length);
        });
      } catch (error) {
        failure = error; // keep what is done so far
        break;
      }
    }

    const now = Date.now();
    this.db.transaction((tx) => {
      for (const { page, items } of plans) {
        if (!items.every((i) => known.has(i.hash))) continue;
        if (!tx.select({ id: pages.id }).from(pages).where(eq(pages.id, page.id)).get()) continue; // purged meanwhile
        tx.delete(pageChunks).where(eq(pageChunks.pageId, page.id)).run();
        if (items.length) {
          tx.insert(pageChunks)
            .values(
              items.map((i) => ({ pageId: page.id, userId, ord: i.ord, heading: i.heading, text: i.text, hash: i.hash, vector: known.get(i.hash)! })),
            )
            .run();
        }
        const cost = items.reduce((sum, i) => sum + (costOf.get(i.hash) ?? 0), 0);
        tx.insert(pageIndex)
          .values({ pageId: page.id, userId, version: page.version, title: page.title, model, indexedAt: now, cost })
          .onConflictDoUpdate({
            target: pageIndex.pageId,
            set: { version: page.version, title: page.title, model, indexedAt: now, cost: sql`${pageIndex.cost} + ${cost}` },
          })
          .run();
      }
    });
    this.cache.delete(userId);
    if (failure) throw failure;
  }

  status(userId: string): SemanticStatus {
    const cfg = this.settings.effective(userId);
    const counts = this.db.$client
      .prepare(
        `SELECT
           (SELECT count(*) FROM pages WHERE user_id = @u AND deleted_at IS NULL) AS pages,
           (SELECT count(*) FROM page_index i JOIN pages p ON p.id = i.page_id
             WHERE i.user_id = @u AND p.deleted_at IS NULL AND i.version = p.version AND i.title = p.title AND i.model = @m) AS indexed,
           (SELECT count(*) FROM page_chunks c JOIN pages p ON p.id = c.page_id WHERE c.user_id = @u AND p.deleted_at IS NULL) AS chunks,
           (SELECT coalesce(sum(cost), 0) FROM page_index WHERE user_id = @u) AS cost`,
      )
      .get({ u: userId, m: cfg.embeddingModel }) as { pages: number; indexed: number; chunks: number; cost: number };
    return {
      enabled: cfg.semanticIndex,
      ready: !!cfg.openrouterApiKey,
      model: cfg.embeddingModel,
      ...counts,
      error: this.errors.get(userId)?.message ?? null,
    };
  }

  /** Deletes a user's index (when switched off: the notes' vectors should not linger). */
  clear(userId: string) {
    this.db.transaction((tx) => {
      tx.delete(pageChunks).where(eq(pageChunks.userId, userId)).run();
      tx.delete(pageIndex).where(eq(pageIndex.userId, userId)).run();
    });
    this.cache.delete(userId);
    this.errors.delete(userId);
  }

  /** Clears a failure so the next run retries at once. */
  retry(userId: string) {
    this.errors.delete(userId);
  }

  private load(userId: string, model: string): VectorCache | null {
    const cached = this.cache.get(userId);
    if (cached?.model === model) return cached;
    const rows = this.db
      .select({ id: pageChunks.id, pageId: pageChunks.pageId, vector: pageChunks.vector })
      .from(pageChunks)
      .innerJoin(pageIndex, eq(pageIndex.pageId, pageChunks.pageId))
      .where(and(eq(pageChunks.userId, userId), eq(pageIndex.model, model)))
      .all();
    if (!rows.length) return null;
    const dims = rows[0]!.vector.length / 4;
    const usable = rows.filter((r) => r.vector.length / 4 === dims);
    const vectors = new Float32Array(usable.length * dims);
    const passages = new Map<string, number[]>();
    usable.forEach((r, i) => {
      vectors.set(fromBlob(r.vector), i * dims);
      passages.set(r.pageId, [...(passages.get(r.pageId) ?? []), i]);
    });
    const pageVectors = new Map<string, Float32Array>();
    for (const [pageId, list] of passages) {
      const mean = new Float32Array(dims);
      for (const i of list) for (let d = 0; d < dims; d++) mean[d]! += vectors[i * dims + d]!;
      let norm = 0;
      for (const x of mean) norm += x * x;
      norm = Math.sqrt(norm) || 1;
      for (let d = 0; d < dims; d++) mean[d]! /= norm;
      pageVectors.set(pageId, mean);
    }
    const cache: VectorCache = { model, dims, chunkIds: usable.map((r) => r.id), pageOf: usable.map((r) => r.pageId), vectors, pageVectors, passages };
    this.cache.set(userId, cache);
    return cache;
  }

  private async embedQuery(cfg: AiConfig, query: string): Promise<Float32Array> {
    const key = `${cfg.embeddingModel}\u0000${query}`;
    const hit = this.queries.get(key);
    if (hit) {
      this.queries.delete(key);
      this.queries.set(key, hit);
      return hit;
    }
    const { vectors } = await this.embedder({ apiKey: cfg.openrouterApiKey!, model: cfg.embeddingModel, inputs: [query] });
    this.queries.set(key, vectors[0]!);
    if (this.queries.size > QUERY_CACHE) this.queries.delete(this.queries.keys().next().value!);
    return vectors[0]!;
  }

  private liveIds(userId: string, ids: string[]): Set<string> {
    if (!ids.length) return new Set();
    const rows = this.db
      .select({ id: pages.id })
      .from(pages)
      .where(and(eq(pages.userId, userId), isNull(pages.deletedAt), inArray(pages.id, ids)))
      .all();
    return new Set(rows.map((r) => r.id));
  }

  private chunkTexts(ids: number[]) {
    if (!ids.length) return new Map<number, { heading: string; text: string }>();
    return new Map(
      this.db
        .select({ id: pageChunks.id, heading: pageChunks.heading, text: pageChunks.text })
        .from(pageChunks)
        .where(inArray(pageChunks.id, ids))
        .all()
        .map((r) => [r.id, r]),
    );
  }

  /** Whether the index can answer for this user; null when it is off. */
  private ready(userId: string) {
    const cfg = this.settings.effective(userId);
    return cfg.semanticIndex && cfg.openrouterApiKey ? cfg : null;
  }

  /** The best matching passages for a query, at most `perPage` from each page. */
  async passages(userId: string, query: string, limit = 10, perPage = 3, cutoff: Cutoff = RETRIEVAL_CUTOFF): Promise<Passage[] | null> {
    const cfg = this.ready(userId);
    if (!cfg) return null;
    const cache = this.load(userId, cfg.embeddingModel);
    if (!cache) return [];
    const q = await this.embedQuery(cfg, query);
    if (q.length !== cache.dims) return [];
    const scored = cache.chunkIds.map((_, i) => ({ i, score: dot(q, cache.vectors, i * cache.dims) }));
    scored.sort((a, b) => b.score - a.score);
    const top = cut(scored, cutoff).slice(0, limit * 4);
    const live = this.liveIds(userId, [...new Set(top.map((s) => cache.pageOf[s.i]!))]);
    const perPageCount = new Map<string, number>();
    const picked = top.filter((s) => {
      const pageId = cache.pageOf[s.i]!;
      const n = perPageCount.get(pageId) ?? 0;
      if (!live.has(pageId) || n >= perPage) return false;
      perPageCount.set(pageId, n + 1);
      return true;
    }).slice(0, limit);
    const texts = this.chunkTexts(picked.map((s) => cache.chunkIds[s.i]!));
    return picked.map((s) => ({
      chunkId: cache.chunkIds[s.i]!,
      pageId: cache.pageOf[s.i]!,
      heading: texts.get(cache.chunkIds[s.i]!)?.heading ?? '',
      text: texts.get(cache.chunkIds[s.i]!)?.text ?? '',
      score: s.score,
    }));
  }

  /** Pages matching a query by meaning, each with its best passage. */
  async search(userId: string, query: string, limit = 8): Promise<SemanticResults<SemanticHit>> {
    const found = await this.passages(userId, query, limit, 1, SEARCH_CUTOFF);
    if (found === null) return { enabled: false, results: [] };
    return { enabled: true, results: this.toHits(userId, found) };
  }

  /**
   * Pages whose content is close to this page's, leaving out `exclude` (pages it is already
   * connected to). Only pages above a similarity floor qualify, so short lists are normal.
   */
  related(userId: string, pageId: string, exclude: Set<string>, limit = 6): SemanticResults<SemanticHit> {
    const cfg = this.ready(userId);
    if (!cfg) return { enabled: false, results: [] };
    const cache = this.load(userId, cfg.embeddingModel);
    const own = cache?.pageVectors.get(pageId);
    if (!cache || !own) return { enabled: true, results: [] };
    const scored = [...cache.pageVectors]
      .filter(([id]) => id !== pageId && !exclude.has(id))
      .map(([id, v]) => ({ id, score: dot(own, v) }))
      .sort((a, b) => b.score - a.score);
    const candidates = cut(scored, RELATED_CUTOFF).slice(0, limit * 2);
    const live = this.liveIds(userId, candidates.map((s) => s.id));
    const picked = candidates.filter((s) => live.has(s.id)).slice(0, limit);
    // Show the passage of each related page that is closest to this page.
    const best = picked.map((s) => {
      const list = cache.passages.get(s.id)!;
      const i = list.reduce((a, b) => (dot(own, cache.vectors, b * cache.dims) > dot(own, cache.vectors, a * cache.dims) ? b : a));
      return { chunkId: cache.chunkIds[i]!, pageId: s.id, heading: '', text: '', score: s.score };
    });
    const texts = this.chunkTexts(best.map((b) => b.chunkId));
    return {
      enabled: true,
      results: this.toHits(
        userId,
        best.map((b) => ({ ...b, heading: texts.get(b.chunkId)?.heading ?? '', text: texts.get(b.chunkId)?.text ?? '' })),
      ),
    };
  }

  /** Page ids closest to a page, without cut-offs (candidates for AI link suggestions); null when off. */
  nearestPages(userId: string, pageId: string, exclude: Set<string>, limit: number): string[] | null {
    const cfg = this.ready(userId);
    if (!cfg) return null;
    const cache = this.load(userId, cfg.embeddingModel);
    const own = cache?.pageVectors.get(pageId);
    if (!cache || !own) return null;
    return [...cache.pageVectors]
      .filter(([id]) => id !== pageId && !exclude.has(id))
      .map(([id, v]) => ({ id, score: dot(own, v) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((s) => s.id);
  }

  private toHits(userId: string, found: Passage[]): SemanticHit[] {
    const ids = [...new Set(found.map((f) => f.pageId))];
    const info = new Map(
      ids.length
        ? this.db
            .select({ id: pages.id, title: pages.title, notebookId: pages.notebookId })
            .from(pages)
            .where(and(eq(pages.userId, userId), inArray(pages.id, ids)))
            .all()
            .map((p) => [p.id, p])
        : [],
    );
    return found
      .filter((f) => info.has(f.pageId))
      .map((f) => ({
        id: f.pageId,
        notebookId: info.get(f.pageId)!.notebookId,
        title: info.get(f.pageId)!.title,
        heading: f.heading,
        excerpt: f.text.length > 240 ? `${f.text.slice(0, 237)}…` : f.text,
        score: Math.round(f.score * 1000) / 1000,
      }));
  }
}

/** Pages a page is already connected to: links both ways, parent and children, templates. */
export function connectedPages(db: Db, userId: string, pageId: string): Set<string> {
  const ctx = loadLinkContext(db, userId);
  const page = ctx.pages.get(pageId);
  if (!page) throw notFound('Page');
  const row = db.select({ content: pages.content }).from(pages).where(eq(pages.id, pageId)).get();
  const ids = new Set<string>(pageIdsWithTag(db, userId, TEMPLATE_TAG));
  for (const ref of extractWikilinks(row?.content ?? '')) {
    const target = resolveWikilink(ctx, ref.target, page.notebookId);
    if (target) ids.add(target.id);
  }
  for (const b of findBacklinks(db, userId, pageId)) ids.add(b.id);
  if (page.parentId) ids.add(page.parentId);
  for (const p of ctx.pages.values()) if (p.parentId === pageId) ids.add(p.id);
  return ids;
}

export function semanticRoutes(db: Db, index: SemanticIndex) {
  return new Hono<AppEnv>()
    .get('/status', (c) => c.json(index.status(c.var.user.id)))
    .post('/rebuild', (c) => {
      index.clear(c.var.user.id);
      index.poke(100);
      return c.json(index.status(c.var.user.id));
    })
    .post('/retry', (c) => {
      index.retry(c.var.user.id);
      index.poke(100);
      return c.json(index.status(c.var.user.id));
    })
    .get('/search', async (c) => {
      const q = (c.req.query('q') ?? '').trim().slice(0, 500);
      const limit = Math.min(Number(c.req.query('limit')) || 8, 20);
      if (q.length < 3) return c.json({ enabled: true, results: [] } satisfies SemanticResults<SemanticHit>);
      try {
        return c.json(await index.search(c.var.user.id, q, limit));
      } catch (error) {
        if (error instanceof LlmError) throw new HTTPException(502, { message: error.message });
        throw error;
      }
    })
    .get('/related/:pageId', (c) => {
      const userId = c.var.user.id;
      const pageId = c.req.param('pageId');
      return c.json(index.related(userId, pageId, connectedPages(db, userId, pageId)));
    });
}
