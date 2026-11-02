import { providerModelId, providerOf } from '@nicotes/shared';
import { LlmError, type ProviderKeys, type Usage } from './llm.js';

const OPENROUTER_ENDPOINT = 'https://openrouter.ai/api/v1/embeddings';
/** Inputs per request; OpenRouter's providers accept larger batches, but errors stay cheap. */
export const EMBED_BATCH = 64;

/**
 * OpenAI's text-embedding-3 models can return shorter vectors with little quality loss; 512
 * dimensions keep the index small (2 KB per passage).
 */
const dimensionsFor = (model: string) => (/^openai\/text-embedding-3-/.test(model) ? 512 : undefined);

export type Embedder = (opts: { keys: ProviderKeys; model: string; inputs: string[]; signal?: AbortSignal }) => Promise<{
  vectors: Float32Array[];
  usage: Usage;
}>;

function normalize(values: number[]): Float32Array {
  const v = Float32Array.from(values);
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < v.length; i++) v[i]! /= norm;
  return v;
}

/** Where a model's embeddings come from: OpenRouter, or your own server for "local:" models. */
function target(keys: ProviderKeys, model: string) {
  const provider = providerOf(model);
  if (provider === 'local') {
    if (!keys.local) throw new LlmError('No address of your own model server configured (Settings)');
    return { label: 'your model server', url: `${keys.local.url}/embeddings`, key: keys.local.key, model: providerModelId(model) };
  }
  if (provider === 'routeway') throw new LlmError('Embeddings run on OpenRouter or your own server; pick one of their models');
  if (!keys.openrouter) throw new LlmError('No OpenRouter API key configured (Settings)');
  return { label: 'OpenRouter', url: OPENROUTER_ENDPOINT, key: keys.openrouter, model };
}

/** Embeds texts; vectors come back normalised, so cosine similarity is a dot product. */
export const embed: Embedder = async ({ keys, model, inputs, signal }) => {
  const t = target(keys, model);
  const timeout = AbortSignal.timeout(60_000);
  let res: Response;
  try {
    res = await fetch(t.url, {
      method: 'POST',
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      headers: { ...(t.key ? { authorization: `Bearer ${t.key}` } : {}), 'content-type': 'application/json', 'x-title': 'Nicotes' },
      body: JSON.stringify({ model: t.model, input: inputs, dimensions: dimensionsFor(t.model) }),
    });
  } catch (error) {
    throw new LlmError(`Cannot reach ${t.label}: ${(error as Error).message}`);
  }
  const data = (await res.json().catch(() => ({}))) as {
    data?: { index?: number; embedding: number[] }[];
    usage?: { prompt_tokens?: number; cost?: number };
    error?: { message?: string } | string;
  };
  if (!res.ok || !data.data) {
    const message = typeof data.error === 'string' ? data.error : data.error?.message;
    if (res.status === 401) throw new LlmError(`${t.label} rejected the API key`);
    if (res.status === 402) throw new LlmError('Your OpenRouter credits are used up');
    if (res.status === 429) throw new LlmError(`${t.label} rate limit reached, try again shortly`);
    throw new LlmError(`Embeddings from ${t.label}: ${message ?? `HTTP ${res.status}`}`);
  }
  const rows = [...data.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  if (rows.length !== inputs.length) throw new LlmError(`${t.label} returned the wrong number of embeddings`);
  return {
    vectors: rows.map((r) => normalize(r.embedding)),
    usage: { promptTokens: data.usage?.prompt_tokens ?? 0, completionTokens: 0, cost: data.usage?.cost ?? 0 },
  };
};

export const toBlob = (v: Float32Array) => Buffer.from(v.buffer, v.byteOffset, v.byteLength);

/** Copies (SQLite buffers need not be 4-byte aligned). */
export const fromBlob = (b: Buffer) => new Float32Array(new Uint8Array(b).buffer);

export function dot(a: Float32Array, b: Float32Array, offset = 0): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i]! * b[offset + i]!;
  return sum;
}
