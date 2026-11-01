import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import {
  AI_TASKS,
  DEFAULT_AI_COST_LIMIT,
  DEFAULT_EMBEDDING_MODEL,
  DEFAULT_OPENROUTER_MODEL,
  DEFAULT_TASK_EXCLUDE_TAGS,
  modelSetting,
  settingsUpdateSchema,
  type AiTask,
  type ConnectionCheck,
  type ModelList,
  type Settings,
  type SettingSource,
  type SettingsUpdate,
} from '@nicotes/shared';
import type { AppEnv } from './auth.js';
import type { Config } from './config.js';
import type { Db } from './db/index.js';
import { settings } from './db/schema.js';
import { readJson } from './http.js';
import { listModels } from './ai/models.js';
import type { ProviderKeys } from './ai/llm.js';
import type { SecretBox } from './secrets.js';

const KEYS = {
  openrouterApiKey: { key: 'openrouter.apiKey', secret: true },
  openrouterModel: { key: 'openrouter.model', secret: false },
  routewayApiKey: { key: 'routeway.apiKey', secret: true },
  localAiUrl: { key: 'local.url', secret: false },
  localAiKey: { key: 'local.apiKey', secret: true },
  crawl4aiUrl: { key: 'crawl4ai.url', secret: false },
  crawl4aiToken: { key: 'crawl4ai.token', secret: true },
  importModel: { key: 'ai.model.import', secret: false },
  organizeModel: { key: 'ai.model.organize', secret: false },
  // Kept under its original key, so research models saved before per-task models still apply.
  researchModel: { key: 'ai.researchModel', secret: false },
  askModel: { key: 'ai.model.ask', secret: false },
  assistantModel: { key: 'ai.model.assistant', secret: false },
  summaryModel: { key: 'ai.model.summary', secret: false },
  linksModel: { key: 'ai.model.links', secret: false },
  layoutModel: { key: 'ai.model.layout', secret: false },
  searxngUrl: { key: 'ai.searxngUrl', secret: false },
  aiCostLimit: { key: 'ai.costLimit', secret: false },
  dailyNotebookId: { key: 'daily.notebookId', secret: false },
  dailyTemplateId: { key: 'daily.templateId', secret: false },
  tasksExcludeTags: { key: 'tasks.excludeTags', secret: false },
  semanticIndex: { key: 'ai.semanticIndex', secret: false },
  embeddingModel: { key: 'ai.embeddingModel', secret: false },
  reminderDigestTime: { key: 'reminders.digestTime', secret: false },
  reminderTimeZone: { key: 'reminders.timeZone', secret: false },
  telegramBotToken: { key: 'telegram.botToken', secret: true },
} as const;
type Name = keyof typeof KEYS;

/** Effective values used by import and AI features (settings > environment > default). */
export interface ImportConfig {
  /** OpenRouter's key; also needed for embeddings (semantic index). */
  openrouterApiKey: string | null;
  /** Keys of all chat model services. */
  keys: ProviderKeys;
  /** The default model. */
  model: string;
  /** The model each AI feature uses (its own, else the default). */
  models: Record<AiTask, string>;
  crawl4aiUrl: string | null;
  crawl4aiToken: string | null;
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
      routewayKey: pick('routewayApiKey'),
      localUrl: pick('localAiUrl'),
      localKey: pick('localAiKey'),
      url: pick('crawl4aiUrl'),
      token: pick('crawl4aiToken'),
      tasks: Object.fromEntries(AI_TASKS.map((task) => [task, pick(modelSetting(task))])) as Record<
        AiTask,
        { value: string | null; source: SettingSource }
      >,
      searxng: pick('searxngUrl'),
      costLimit: pick('aiCostLimit', String(DEFAULT_AI_COST_LIMIT)),
      dailyNotebook: pick('dailyNotebookId'),
      dailyTemplate: pick('dailyTemplateId'),
      excludeTags: pick('tasksExcludeTags', JSON.stringify(DEFAULT_TASK_EXCLUDE_TAGS)),
      semanticIndex: pick('semanticIndex', 'false'),
      embeddingModel: pick('embeddingModel', DEFAULT_EMBEDDING_MODEL),
      digestTime: pick('reminderDigestTime'),
      timeZone: pick('reminderTimeZone'),
      telegramToken: pick('telegramBotToken'),
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
      routeway: { apiKeySet: r.routewayKey.value !== null, apiKeySource: r.routewayKey.source },
      local: {
        url: r.localUrl.value,
        urlSource: r.localUrl.source,
        apiKeySet: r.localKey.value !== null,
        apiKeySource: r.localKey.source,
      },
      crawl4ai: {
        url: r.url.value,
        urlSource: r.url.source,
        tokenSet: r.token.value !== null,
        tokenSource: r.token.source,
      },
      models: Object.fromEntries(
        AI_TASKS.map((task) => [task, { model: r.tasks[task].value, source: r.tasks[task].source }]),
      ) as Settings['models'],
      ai: {
        searxngUrl: r.searxng.value,
        searxngUrlSource: r.searxng.source,
        costLimit: Number(r.costLimit.value),
        costLimitSource: r.costLimit.source,
      },
      daily: { notebookId: r.dailyNotebook.value, templateId: r.dailyTemplate.value },
      tasks: { excludeTags: parseList(r.excludeTags.value), excludeTagsSource: r.excludeTags.source },
      reminders: {
        digestTime: r.digestTime.value,
        timeZone: r.timeZone.value,
        telegramTokenSet: r.telegramToken.value !== null,
        telegramTokenSource: r.telegramToken.source,
      },
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
      keys: {
        openrouter: r.apiKey.value,
        routeway: r.routewayKey.value,
        local: r.localUrl.value ? { url: r.localUrl.value.replace(/\/+$/, ''), key: r.localKey.value } : null,
      },
      model: r.model.value!,
      models: Object.fromEntries(AI_TASKS.map((task) => [task, r.tasks[task].value ?? r.model.value!])) as Record<AiTask, string>,
      crawl4aiUrl: r.url.value?.replace(/\/+$/, '') ?? null,
      crawl4aiToken: r.token.value,
      searxngUrl: r.searxng.value?.replace(/\/+$/, '') ?? null,
      costLimit: Number(r.costLimit.value) || DEFAULT_AI_COST_LIMIT,
      semanticIndex: r.semanticIndex.value === 'true',
      embeddingModel: r.embeddingModel.value!,
    };
  }

  /** Reminder settings with the bot token itself, for the reminder service only. */
  reminders(userId: string) {
    const r = this.resolve(userId);
    return { digestTime: r.digestTime.value, timeZone: r.timeZone.value, telegramToken: r.telegramToken.value };
  }

  /**
   * Values the server keeps per account that are no user setting (keys it generated, a linked
   * chat). Same table, under `internal.` keys; secrets are encrypted.
   */
  internal(userId: string, key: string, secret = false): string | null {
    const row = this.db
      .select({ value: settings.value })
      .from(settings)
      .where(and(eq(settings.userId, userId), eq(settings.key, `internal.${key}`)))
      .get();
    if (!row) return null;
    return secret ? this.box.decrypt(row.value) : row.value;
  }

  setInternal(userId: string, key: string, value: string | null, secret = false) {
    const where = and(eq(settings.userId, userId), eq(settings.key, `internal.${key}`));
    if (value === null) {
      this.db.delete(settings).where(where).run();
      return;
    }
    const stored = secret ? this.box.encrypt(value) : value;
    const now = Date.now();
    this.db
      .insert(settings)
      .values({ userId, key: `internal.${key}`, value: stored, updatedAt: now })
      .onConflictDoUpdate({ target: [settings.userId, settings.key], set: { value: stored, updatedAt: now } })
      .run();
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

export async function checkRouteway(apiKey: string | null): Promise<ConnectionCheck> {
  if (!apiKey) return { ok: false, message: 'No API key configured' };
  const headers = { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' };
  try {
    // Only account keys may read the balance, so the key is checked with a chat request
    // without messages: Routeway authenticates it (401 for a wrong key) and then rejects the
    // empty request (422) before any model runs, so nothing is charged.
    const probe = await fetch('https://api.routeway.ai/v1/chat/completions', {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: 'gpt-4o-mini', messages: [] }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (probe.status === 401 || probe.status === 403) return { ok: false, message: 'Routeway rejected the API key' };
    if (probe.status >= 500 || probe.status === 429) return { ok: false, message: `Routeway answered ${probe.status}` };
    // The balance, where the key may read it.
    const balance = await fetch('https://api.routeway.ai/v1/account/balance', { headers, signal: AbortSignal.timeout(TIMEOUT_MS) })
      .then(async (res) => (res.ok ? ((await res.json()) as { balance?: number }).balance : undefined))
      .catch(() => undefined);
    return { ok: true, message: `The key works${typeof balance === 'number' ? ` · $${balance.toFixed(2)} balance` : ''}` };
  } catch (error) {
    return { ok: false, message: `Cannot reach Routeway: ${(error as Error).message}` };
  }
}

/** Your own server: lists its models (OpenAI's `/models`), which also checks the key. */
export async function checkLocal(local: ProviderKeys['local']): Promise<ConnectionCheck> {
  if (!local) return { ok: false, message: 'No address configured' };
  try {
    const res = await fetch(`${local.url}/models`, {
      headers: local.key ? { authorization: `Bearer ${local.key}` } : {},
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 401 || res.status === 403) return { ok: false, message: 'Your model server rejected the key' };
    if (res.status === 404 && !/\/v1$/.test(local.url)) {
      return { ok: false, message: 'Not found: most servers need the address of their OpenAI API, ending in /v1' };
    }
    if (!res.ok) return { ok: false, message: `Your model server answered ${res.status}` };
    const body = (await res.json()) as { data?: { id: string }[] };
    const count = body.data?.length ?? 0;
    return count
      ? { ok: true, message: `Reachable · ${count} model${count === 1 ? '' : 's'} installed` }
      : { ok: false, message: 'Reachable, but it has no models installed yet' };
  } catch (error) {
    return { ok: false, message: `Cannot reach your model server: ${(error as Error).cause ?? (error as Error).message}` };
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
  if (!url) return { ok: false, message: 'No SearXNG URL configured — research uses the web search of its AI model' };
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

export function settingsRoutes(store: SettingsStore) {
  return new Hono<AppEnv>()
    .get('/', (c) => c.json(store.view(c.var.user.id)))
    .patch('/', async (c) => {
      store.update(c.var.user.id, await readJson(c, settingsUpdateSchema));
      return c.json(store.view(c.var.user.id));
    })
    .post('/check', async (c) => {
      const { target } = await readJson(c, z.object({ target: z.enum(['openrouter', 'routeway', 'local', 'crawl4ai', 'searxng']) }));
      const cfg = store.effective(c.var.user.id);
      const checks = {
        openrouter: () => checkOpenRouter(cfg.openrouterApiKey),
        routeway: () => checkRouteway(cfg.keys.routeway),
        local: () => checkLocal(cfg.keys.local),
        crawl4ai: () => checkCrawl4ai(cfg.crawl4aiUrl, cfg.crawl4aiToken),
        searxng: () => checkSearxng(cfg.searxngUrl),
      };
      return c.json(await checks[target]());
    })
    .get('/models', async (c) => {
      const kind = c.req.query('kind') === 'embedding' ? 'embedding' : 'chat';
      const local = store.effective(c.var.user.id).keys.local;
      return c.json((await listModels(kind, c.req.query('refresh') === '1', local)) satisfies ModelList);
    });
}
