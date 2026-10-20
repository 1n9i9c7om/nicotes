import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import {
  DEFAULT_AI_COST_LIMIT,
  DEFAULT_EMBEDDING_MODEL,
  DEFAULT_OPENROUTER_MODEL,
  DEFAULT_TASK_EXCLUDE_TAGS,
  settingsUpdateSchema,
  type ConnectionCheck,
  type ModelInfo,
  type Settings,
  type SettingSource,
  type SettingsUpdate,
} from '@nicotes/shared';
import type { AppEnv } from './auth.js';
import type { Config } from './config.js';
import type { Db } from './db/index.js';
import { settings } from './db/schema.js';
import { readJson } from './http.js';
import type { SecretBox } from './secrets.js';

const KEYS = {
  openrouterApiKey: { key: 'openrouter.apiKey', secret: true },
  openrouterModel: { key: 'openrouter.model', secret: false },
  crawl4aiUrl: { key: 'crawl4ai.url', secret: false },
  crawl4aiToken: { key: 'crawl4ai.token', secret: true },
  researchModel: { key: 'ai.researchModel', secret: false },
  searxngUrl: { key: 'ai.searxngUrl', secret: false },
  aiCostLimit: { key: 'ai.costLimit', secret: false },
  dailyNotebookId: { key: 'daily.notebookId', secret: false },
  dailyTemplateId: { key: 'daily.templateId', secret: false },
  tasksExcludeTags: { key: 'tasks.excludeTags', secret: false },
  semanticIndex: { key: 'ai.semanticIndex', secret: false },
  embeddingModel: { key: 'ai.embeddingModel', secret: false },
} as const;
type Name = keyof typeof KEYS;

/** Effective values used by import and AI features (settings > environment > default). */
export interface ImportConfig {
  openrouterApiKey: string | null;
  model: string;
  crawl4aiUrl: string | null;
  crawl4aiToken: string | null;
  researchModel: string;
  searxngUrl: string | null;
  /** USD per AI job. */
  costLimit: number;
  semanticIndex: boolean;
  embeddingModel: string;
}
export type AiConfig = ImportConfig;

export class SettingsStore {
  private listeners: ((userId: string, input: SettingsUpdate) => void)[] = [];

  constructor(
    private db: Db,
    private box: SecretBox,
    private env: Partial<Record<Name, string>>,
  ) {}

  private stored(userId: string): Partial<Record<Name, string>> {
    const rows = this.db.select().from(settings).where(eq(settings.userId, userId)).all();
    const result: Partial<Record<Name, string>> = {};
    for (const [name, def] of Object.entries(KEYS) as [Name, (typeof KEYS)[Name]][]) {
      const row = rows.find((r) => r.key === def.key);
      if (!row) continue;
      const value = def.secret ? this.box.decrypt(row.value) : row.value;
      if (value) result[name] = value;
    }
    return result;
  }

  private resolve(userId: string) {
    const stored = this.stored(userId);
    const pick = (name: Name, fallback?: string): { value: string | null; source: SettingSource } =>
      stored[name] !== undefined
        ? { value: stored[name]!, source: 'settings' }
        : this.env[name]
          ? { value: this.env[name]!, source: 'env' }
          : fallback
            ? { value: fallback, source: 'default' }
            : { value: null, source: null };
    return {
      apiKey: pick('openrouterApiKey'),
      model: pick('openrouterModel', DEFAULT_OPENROUTER_MODEL),
      url: pick('crawl4aiUrl'),
      token: pick('crawl4aiToken'),
      researchModel: pick('researchModel'),
      searxng: pick('searxngUrl'),
      costLimit: pick('aiCostLimit', String(DEFAULT_AI_COST_LIMIT)),
      dailyNotebook: pick('dailyNotebookId'),
      dailyTemplate: pick('dailyTemplateId'),
      excludeTags: pick('tasksExcludeTags', JSON.stringify(DEFAULT_TASK_EXCLUDE_TAGS)),
      semanticIndex: pick('semanticIndex', 'false'),
      embeddingModel: pick('embeddingModel', DEFAULT_EMBEDDING_MODEL),
    };
  }

  /** What the settings page shows: never the secrets themselves. */
  view(userId: string): Settings {
    const r = this.resolve(userId);
    return {
      openrouter: {
        apiKeySet: r.apiKey.value !== null,
        apiKeySource: r.apiKey.source,
        model: r.model.value!,
        modelSource: r.model.source,
      },
      crawl4ai: {
        url: r.url.value,
        urlSource: r.url.source,
        tokenSet: r.token.value !== null,
        tokenSource: r.token.source,
      },
      ai: {
        researchModel: r.researchModel.value ?? r.model.value!,
        researchModelSource: r.researchModel.source ?? 'default',
        searxngUrl: r.searxng.value,
        searxngUrlSource: r.searxng.source,
        costLimit: Number(r.costLimit.value),
        costLimitSource: r.costLimit.source,
      },
      daily: { notebookId: r.dailyNotebook.value, templateId: r.dailyTemplate.value },
      tasks: { excludeTags: parseList(r.excludeTags.value), excludeTagsSource: r.excludeTags.source },
      semantic: {
        enabled: r.semanticIndex.value === 'true',
        enabledSource: r.semanticIndex.source,
        model: r.embeddingModel.value!,
        modelSource: r.embeddingModel.source,
      },
    };
  }

  effective(userId: string): ImportConfig {
    const r = this.resolve(userId);
    return {
      openrouterApiKey: r.apiKey.value,
      model: r.model.value!,
      crawl4aiUrl: r.url.value?.replace(/\/+$/, '') ?? null,
      crawl4aiToken: r.token.value,
      researchModel: r.researchModel.value ?? r.model.value!,
      searxngUrl: r.searxng.value?.replace(/\/+$/, '') ?? null,
      costLimit: Number(r.costLimit.value) || DEFAULT_AI_COST_LIMIT,
      semanticIndex: r.semanticIndex.value === 'true',
      embeddingModel: r.embeddingModel.value!,
    };
  }

  /** Called after every update, e.g. to start or clear the semantic index. */
  onUpdate(listener: (userId: string, input: SettingsUpdate) => void) {
    this.listeners.push(listener);
  }

  update(userId: string, input: SettingsUpdate) {
    const now = Date.now();
    this.db.transaction((tx) => {
      for (const [name, def] of Object.entries(KEYS) as [Name, (typeof KEYS)[Name]][]) {
        const value = input[name];
        if (value === undefined) continue;
        const where = and(eq(settings.userId, userId), eq(settings.key, def.key));
        // An empty string or null clears the stored value, falling back to env/default.
        if (value === null || value === '') {
          tx.delete(settings).where(where).run();
          continue;
        }
        // Lists are stored as JSON, so an empty list stays distinct from "not set".
        const text = Array.isArray(value) ? JSON.stringify(value) : String(value);
        const stored = def.secret ? this.box.encrypt(text) : text;
        tx.insert(settings)
          .values({ userId, key: def.key, value: stored, updatedAt: now })
          .onConflictDoUpdate({ target: [settings.userId, settings.key], set: { value: stored, updatedAt: now } })
          .run();
      }
    });
    for (const listener of this.listeners) listener(userId, input);
  }
}

function parseList(value: string | null): string[] {
  try {
    const list = JSON.parse(value ?? '[]') as unknown;
    return Array.isArray(list) ? list.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

// ---------- Connection checks ----------

const TIMEOUT_MS = 10_000;

export async function checkOpenRouter(apiKey: string | null): Promise<ConnectionCheck> {
  if (!apiKey) return { ok: false, message: 'No API key configured' };
  try {
    const res = await fetch('https://openrouter.ai/api/v1/key', {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 401) return { ok: false, message: 'OpenRouter rejected the API key' };
    if (!res.ok) return { ok: false, message: `OpenRouter answered ${res.status}` };
    const body = (await res.json()) as { data?: { label?: string; limit_remaining?: number | null } };
    const remaining = body.data?.limit_remaining;
    return {
      ok: true,
      message: `Key "${body.data?.label ?? 'unnamed'}" works${typeof remaining === 'number' ? ` · $${remaining.toFixed(2)} left` : ''}`,
    };
  } catch (error) {
    return { ok: false, message: `Cannot reach OpenRouter: ${(error as Error).message}` };
  }
}

export async function checkCrawl4ai(url: string | null, token: string | null): Promise<ConnectionCheck> {
  if (!url) return { ok: false, message: 'No crawl4ai URL configured — imports use the built-in extractor' };
  try {
    const health = await fetch(`${url}/health`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!health.ok) return { ok: false, message: `crawl4ai answered ${health.status}` };
    const { version } = (await health.json()) as { version?: string };
    // /health is public; an authenticated endpoint verifies the token.
    const auth = await fetch(`${url}/schema`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (auth.status === 401 || auth.status === 403) {
      return { ok: false, message: token ? 'crawl4ai rejected the token' : 'crawl4ai requires a token' };
    }
    return { ok: true, message: `crawl4ai ${version ?? ''} is reachable`.replace('  ', ' ') };
  } catch (error) {
    return { ok: false, message: `Cannot reach crawl4ai: ${(error as Error).cause ?? (error as Error).message}` };
  }
}

export async function checkSearxng(url: string | null): Promise<ConnectionCheck> {
  if (!url) return { ok: false, message: 'No SearXNG URL configured — research uses OpenRouter web search' };
  try {
    const res = await fetch(`${url}/search?q=nicotes&format=json`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (res.status === 403) return { ok: false, message: 'SearXNG refuses JSON: enable "json" under search.formats' };
    if (!res.ok) return { ok: false, message: `SearXNG answered ${res.status}` };
    const body = (await res.json()) as { results?: unknown[] };
    return { ok: true, message: `SearXNG works (${body.results?.length ?? 0} results for a test query)` };
  } catch (error) {
    return { ok: false, message: `Cannot reach SearXNG: ${(error as Error).cause ?? (error as Error).message}` };
  }
}

let modelCache: { at: number; models: ModelInfo[] } | null = null;

/** OpenRouter's public model list (cached for an hour), for the model picker. */
async function listModels(): Promise<ModelInfo[]> {
  if (modelCache && Date.now() - modelCache.at < 60 * 60 * 1000) return modelCache.models;
  const res = await fetch('https://openrouter.ai/api/v1/models', { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new HTTPException(502, { message: `OpenRouter answered ${res.status}` });
  const body = (await res.json()) as { data: { id: string; name: string; pricing?: { prompt?: string } }[] };
  const models = body.data
    .map((m) => ({
      id: m.id,
      name: m.name,
      promptPrice: m.pricing?.prompt ? Number(m.pricing.prompt) * 1_000_000 : null,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  modelCache = { at: Date.now(), models };
  return models;
}

export function settingsRoutes(store: SettingsStore) {
  return new Hono<AppEnv>()
    .get('/', (c) => c.json(store.view(c.var.user.id)))
    .patch('/', async (c) => {
      store.update(c.var.user.id, await readJson(c, settingsUpdateSchema));
      return c.json(store.view(c.var.user.id));
    })
    .post('/check', async (c) => {
      const { target } = await readJson(c, z.object({ target: z.enum(['openrouter', 'crawl4ai', 'searxng']) }));
      const cfg = store.effective(c.var.user.id);
      const result =
        target === 'openrouter'
          ? await checkOpenRouter(cfg.openrouterApiKey)
          : target === 'crawl4ai'
            ? await checkCrawl4ai(cfg.crawl4aiUrl, cfg.crawl4aiToken)
            : await checkSearxng(cfg.searxngUrl);
      return c.json(result);
    })
    .get('/models', async (c) => c.json(await listModels()));
}
