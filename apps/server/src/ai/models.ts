import { LOCAL_PREFIX, ROUTEWAY_PREFIX, providerModelId, providerOf, type AiProvider, type ModelInfo } from '@nicotes/shared';
import { LlmError, type ProviderKeys } from './llm.js';

export type ModelKind = 'chat' | 'embedding';

const TIMEOUT_MS = 10_000;
const CACHE_MS = 60 * 60 * 1000;

interface OpenRouterModel {
  id: string;
  name: string;
  context_length?: number | null;
  pricing?: { prompt?: string; completion?: string };
  supported_parameters?: string[];
}

interface RoutewayModel {
  id: string;
  name: string;
  context_length?: number | null;
  available?: boolean;
  endpoints?: string[];
  pricing?: { input?: { price_per_million_t?: number }; output?: { price_per_million_t?: number } };
  capabilities?: { function_call?: boolean; reasoning?: boolean };
}

async function getJson<T>(url: string, service: string, key?: string | null): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { headers: key ? { authorization: `Bearer ${key}` } : {}, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (error) {
    throw new LlmError(`Cannot reach ${service}: ${(error as Error).message}`);
  }
  if (!res.ok) throw new LlmError(`${service} answered ${res.status}`);
  return (await res.json()) as T;
}

/**
 * The models installed on your own server (OpenAI's `/models`), which says nothing about
 * what a model does: names with "embed" count as embedding models, the rest as chat models.
 */
export async function localModels(local: NonNullable<ProviderKeys['local']>, kind: ModelKind): Promise<ModelInfo[]> {
  const body = await getJson<{ data?: { id: string }[] }>(`${local.url}/models`, 'your model server', local.key);
  return (body.data ?? [])
    .filter((m) => /embed/i.test(m.id) === (kind === 'embedding'))
    .map((m) => ({
      id: `${LOCAL_PREFIX}${m.id}`,
      name: m.id,
      provider: 'local' as const,
      promptPrice: 0,
      completionPrice: kind === 'chat' ? 0 : null,
      contextLength: null,
      tools: false,
      reasoning: false,
      free: true,
    }));
}

async function openRouterModels(kind: ModelKind): Promise<ModelInfo[]> {
  const url = kind === 'chat' ? 'https://openrouter.ai/api/v1/models' : 'https://openrouter.ai/api/v1/embeddings/models';
  const body = await getJson<{ data: OpenRouterModel[] }>(url, 'OpenRouter');
  const perMillion = (price?: string) => (price ? Number(price) * 1_000_000 : null);
  return body.data.map((m) => {
    const promptPrice = perMillion(m.pricing?.prompt);
    const completionPrice = kind === 'chat' ? perMillion(m.pricing?.completion) : null;
    return {
      id: m.id,
      name: m.name,
      provider: 'openrouter',
      promptPrice,
      completionPrice,
      contextLength: m.context_length ?? null,
      tools: m.supported_parameters?.includes('tools') ?? false,
      reasoning: m.supported_parameters?.includes('reasoning') ?? false,
      free: m.id.endsWith(':free') || (promptPrice === 0 && (completionPrice ?? 0) === 0),
    };
  });
}

async function routewayModels(): Promise<ModelInfo[]> {
  const body = await getJson<{ data: RoutewayModel[] }>('https://api.routeway.ai/v1/models', 'Routeway');
  return body.data
    .filter((m) => m.available !== false && (m.endpoints ?? []).includes('/v1/chat/completions'))
    .map((m) => {
      const promptPrice = m.pricing?.input?.price_per_million_t ?? null;
      const completionPrice = m.pricing?.output?.price_per_million_t ?? null;
      return {
        id: `${ROUTEWAY_PREFIX}${m.id}`,
        name: m.name,
        provider: 'routeway',
        promptPrice,
        completionPrice,
        contextLength: m.context_length ?? null,
        tools: m.capabilities?.function_call ?? false,
        reasoning: m.capabilities?.reasoning ?? false,
        free: m.id.endsWith(':free') || (promptPrice === 0 && completionPrice === 0),
      };
    });
}

const cache = new Map<string, { at: number; models: ModelInfo[] }>();
/** Your own server's list changes whenever you pull a model, so it is kept shorter. */
const LOCAL_CACHE_MS = 5 * 60 * 1000;

async function cached(key: string, load: () => Promise<ModelInfo[]>, refresh: boolean, maxAge = CACHE_MS): Promise<ModelInfo[]> {
  const hit = cache.get(key);
  if (hit && !refresh && Date.now() - hit.at < maxAge) return hit.models;
  const models = await load();
  cache.set(key, { at: Date.now(), models });
  return models;
}

/**
 * The model lists for the model pickers: chat models of OpenRouter and Routeway, embedding
 * models of OpenRouter (cached for an hour), plus your own server's when one is set up. A
 * service that cannot be reached is left out.
 */
export async function listModels(
  kind: ModelKind,
  refresh = false,
  local: ProviderKeys['local'] = null,
): Promise<{ models: ModelInfo[]; errors: string[] }> {
  const sources: [string, () => Promise<ModelInfo[]>, number?][] =
    kind === 'chat'
      ? [
          ['openrouter:chat', () => openRouterModels('chat')],
          ['routeway:chat', routewayModels],
        ]
      : [['openrouter:embedding', () => openRouterModels('embedding')]];
  if (local) sources.push([`local:${local.url}:${kind}`, () => localModels(local, kind), LOCAL_CACHE_MS]);
  const results = await Promise.allSettled(sources.map(([key, load, maxAge]) => cached(key, load, refresh, maxAge)));
  const models = results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
  const errors = results.flatMap((r) => (r.status === 'rejected' ? [(r.reason as Error).message] : []));
  return { models: models.sort((a, b) => a.name.localeCompare(b.name)), errors };
}

/**
 * Routeway reports tokens but no cost, so the cost is computed from its price list. Unknown
 * models (or an unreachable list) count as free rather than failing the request.
 */
export async function estimateCost(model: string, promptTokens: number, completionTokens: number): Promise<number> {
  const provider: AiProvider = providerOf(model);
  if (provider !== 'routeway') return 0;
  try {
    const models = await cached('routeway:chat', routewayModels, false);
    const id = `${ROUTEWAY_PREFIX}${providerModelId(model).replace(/@online$/, '')}`;
    const info = models.find((m) => m.id === id);
    if (!info) return 0;
    return ((info.promptPrice ?? 0) * promptTokens + (info.completionPrice ?? 0) * completionTokens) / 1_000_000;
  } catch {
    return 0;
  }
}
