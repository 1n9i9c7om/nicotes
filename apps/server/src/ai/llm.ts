import type { z } from 'zod';
import { AI_PROVIDER_LABELS, providerModelId, providerOf, type AiProvider } from '@nicotes/shared';
import { estimateCost } from './models.js';

export class LlmError extends Error {}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  /** USD: reported by OpenRouter, computed from the price list for Routeway (0 if unknown). */
  cost: number;
}

export const addUsage = (a: Usage, b: Usage): Usage => ({
  promptTokens: a.promptTokens + b.promptTokens,
  completionTokens: a.completionTokens + b.completionTokens,
  cost: a.cost + b.cost,
});

export const emptyUsage = (): Usage => ({ promptTokens: 0, completionTokens: 0, cost: 0 });

/** API keys per service; a model's id decides which one is used (see `providerOf`). */
export type ProviderKeys = Record<AiProvider, string | null>;

/** Whether the service that runs `model` has a key. */
export const hasKeyFor = (keys: ProviderKeys, model: string) => !!keys[providerOf(model)];

/** E.g. "Asking needs a Routeway API key — add one under Settings." */
export const missingKeyMessage = (what: string, model: string) =>
  `${what} needs ${providerOf(model) === 'routeway' ? 'a Routeway' : 'an OpenRouter'} API key — add one under Settings.`;

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface Citation {
  url: string;
  title: string;
  content: string;
}

interface CompletionResponse {
  choices?: {
    message?: {
      content?: string | null;
      annotations?: { type: string; url_citation?: { url: string; title?: string; content?: string } }[];
    };
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
  error?: { message?: string };
}

export type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high';

export interface ChatOptions {
  keys: ProviderKeys;
  model: string;
  messages: ChatMessage[];
  maxTokens: number;
  json?: boolean;
  /**
   * Reasoning tokens count against max_tokens and some models (e.g. GLM 5.3 FlashX) cannot
   * turn reasoning off, so extraction uses "minimal"; models that reject the setting are
   * retried without it.
   */
  effort?: ReasoningEffort;
  /** Web search with up to this many results: OpenRouter's web plugin, Routeway's "@online". */
  webResults?: number;
  signal?: AbortSignal;
}

const ENDPOINTS: Record<AiProvider, string> = {
  openrouter: 'https://openrouter.ai/api/v1/chat/completions',
  routeway: 'https://api.routeway.ai/v1/chat/completions',
};

/** The service that runs a model, its key and the model id it expects. */
function route(opts: Pick<ChatOptions, 'keys' | 'model' | 'webResults'>) {
  const provider = providerOf(opts.model);
  const label = AI_PROVIDER_LABELS[provider];
  const key = opts.keys[provider];
  if (!key) throw new LlmError(`No ${label} API key configured (Settings)`);
  const id = providerModelId(opts.model);
  return { provider, label, key, model: provider === 'routeway' && opts.webResults ? `${id}@online` : id };
}

type Route = ReturnType<typeof route>;

/** The request body; the two services differ in reasoning, usage and web search options. */
function requestBody(r: Route, opts: ChatOptions, stream: boolean) {
  const common = {
    model: r.model,
    messages: opts.messages,
    // JSON mode; schemas are described in the prompt and validated by the caller, since
    // not every model supports strict structured outputs.
    ...(opts.json ? { response_format: { type: 'json_object' } } : {}),
    temperature: 0.2,
    max_tokens: opts.maxTokens,
  };
  if (r.provider === 'openrouter') {
    return {
      ...common,
      reasoning: { effort: opts.effort ?? 'minimal', exclude: true },
      usage: { include: true },
      ...(opts.webResults ? { plugins: [{ id: 'web', max_results: opts.webResults }] } : {}),
      ...(stream ? { stream: true } : {}),
    };
  }
  // Routeway leaves reasoning off unless asked for and reports usage in the last chunk on request.
  return {
    ...common,
    ...(opts.effort && opts.effort !== 'minimal' ? { reasoning_effort: opts.effort } : {}),
    ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}),
  };
}

const withoutReasoning = (body: object) => {
  const { reasoning: _a, reasoning_effort: _b, ...rest } = body as Record<string, unknown>;
  return rest;
};

function httpError(r: Route, status: number, message?: string): LlmError {
  if (status === 401) return new LlmError(`${r.label} rejected the API key`);
  if (status === 402) return new LlmError(`Your ${r.label} credits are used up`);
  if (status === 429) return new LlmError(`${r.label} rate limit reached, try again shortly`);
  return new LlmError(`${r.label} error: ${message ?? `HTTP ${status}`}`);
}

async function usageOf(r: Route, model: string, raw?: CompletionResponse['usage']): Promise<Usage> {
  const promptTokens = raw?.prompt_tokens ?? 0;
  const completionTokens = raw?.completion_tokens ?? 0;
  const cost = r.provider === 'openrouter' ? (raw?.cost ?? 0) : await estimateCost(model, promptTokens, completionTokens);
  return { promptTokens, completionTokens, cost };
}

export async function chat(opts: ChatOptions): Promise<{ content: string; usage: Usage; citations: Citation[] }> {
  const r = route(opts);
  const body = requestBody(r, opts, false);

  const send = async (payload: object) => {
    try {
      return await fetch(ENDPOINTS[r.provider], {
        method: 'POST',
        signal: opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(180_000)]) : AbortSignal.timeout(180_000),
        headers: { authorization: `Bearer ${r.key}`, 'content-type': 'application/json', 'x-title': 'Nicotes' },
        body: JSON.stringify(payload),
      });
    } catch (error) {
      if (opts.signal?.aborted) throw new LlmError('Cancelled');
      const timeout = (error as Error).name === 'TimeoutError';
      throw new LlmError(timeout ? 'The model took too long to answer' : `Cannot reach ${r.label}: ${(error as Error).message}`);
    }
  };

  let res = await send(body);
  let data = (await res.json().catch(() => ({}))) as CompletionResponse;
  if (res.status === 400 && /reasoning|effort/i.test(data.error?.message ?? '')) {
    res = await send(withoutReasoning(body));
    data = (await res.json().catch(() => ({}))) as CompletionResponse;
  }
  if (!res.ok) throw httpError(r, res.status, data.error?.message);
  const message = data.choices?.[0]?.message;
  return {
    content: message?.content ?? '',
    usage: await usageOf(r, opts.model, data.usage),
    citations: (message?.annotations ?? [])
      .filter((a) => a.type === 'url_citation' && a.url_citation?.url)
      .map((a) => ({ url: a.url_citation!.url, title: a.url_citation!.title ?? '', content: a.url_citation!.content ?? '' })),
  };
}

/**
 * A chat completion streamed token by token (`onDelta` gets each piece of text). Returns the
 * full text and the usage reported in the last event.
 */
export async function streamChat(
  opts: Omit<ChatOptions, 'json' | 'webResults'>,
  onDelta: (text: string) => void,
): Promise<{ content: string; usage: Usage }> {
  const r = route(opts);
  const body = requestBody(r, opts, true);
  const signal = opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(180_000)]) : AbortSignal.timeout(180_000);
  const send = (payload: object) =>
    fetch(ENDPOINTS[r.provider], {
      method: 'POST',
      signal,
      headers: { authorization: `Bearer ${r.key}`, 'content-type': 'application/json', 'x-title': 'Nicotes' },
      body: JSON.stringify(payload),
    });

  let res: Response;
  try {
    res = await send(body);
    if (res.status === 400) {
      const error = (await res.clone().json().catch(() => ({}))) as CompletionResponse;
      if (/reasoning|effort/i.test(error.error?.message ?? '')) res = await send(withoutReasoning(body));
    }
  } catch (error) {
    if (opts.signal?.aborted) throw new LlmError('Cancelled');
    throw new LlmError(`Cannot reach ${r.label}: ${(error as Error).message}`);
  }
  if (!res.ok || !res.body) {
    const data = (await res.json().catch(() => ({}))) as CompletionResponse;
    throw httpError(r, res.status, data.error?.message);
  }

  let content = '';
  let rawUsage: CompletionResponse['usage'];
  let buffer = '';
  const decoder = new TextDecoder();
  const handle = (line: string) => {
    // Server-sent events; lines starting with ":" are keep-alive comments.
    if (!line.startsWith('data:')) return;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') return;
    const event = JSON.parse(data) as {
      choices?: { delta?: { content?: string | null } }[];
      usage?: CompletionResponse['usage'];
      error?: { message?: string };
    };
    if (event.error) throw new LlmError(`${r.label} error: ${event.error.message ?? 'stream failed'}`);
    const piece = event.choices?.[0]?.delta?.content;
    if (piece) {
      content += piece;
      onDelta(piece);
    }
    if (event.usage) rawUsage = event.usage;
  };
  try {
    for await (const bytes of res.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(bytes, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) handle(line);
    }
    handle(buffer);
  } catch (error) {
    if (error instanceof LlmError) throw error;
    if (opts.signal?.aborted) throw new LlmError('Cancelled');
    throw new LlmError(`The answer was interrupted: ${(error as Error).message}`);
  }
  return { content, usage: await usageOf(r, opts.model, rawUsage) };
}

/** Pulls the JSON object out of a reply, tolerating code fences or chatter around it. */
export function parseJsonReply(content: string): unknown {
  const unfenced = content.replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, '');
  try {
    return JSON.parse(unfenced);
  } catch {
    const start = unfenced.indexOf('{');
    const end = unfenced.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(unfenced.slice(start, end + 1));
    throw new Error('no JSON object found');
  }
}

/**
 * Asks for a JSON object and validates it with `schema`, giving the model one chance to
 * fix invalid output.
 */
export async function completeJson<S extends z.ZodType>(opts: {
  keys: ProviderKeys;
  model: string;
  system: string;
  user: string;
  schema: S;
  maxTokens?: number;
  effort?: ReasoningEffort;
  signal?: AbortSignal;
}): Promise<{ data: z.infer<S>; usage: Usage }> {
  const messages: ChatMessage[] = [
    { role: 'system', content: opts.system },
    { role: 'user', content: opts.user },
  ];
  let usage = emptyUsage();
  let problem = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    const reply = await chat({
      keys: opts.keys,
      model: opts.model,
      messages,
      maxTokens: opts.maxTokens ?? 4000,
      json: true,
      effort: opts.effort,
      signal: opts.signal,
    });
    usage = addUsage(usage, reply.usage);
    try {
      if (!reply.content.trim()) throw new Error('empty reply');
      const result = opts.schema.safeParse(parseJsonReply(reply.content));
      if (result.success) return { data: result.data, usage };
      problem = result.error.issues
        .slice(0, 5)
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ');
    } catch (error) {
      problem = (error as Error).message;
    }
    messages.push(
      { role: 'assistant', content: reply.content },
      { role: 'user', content: `That reply was not valid (${problem}). Answer again with only the corrected JSON object.` },
    );
  }
  throw new LlmError(`The model returned unusable data (${problem})`);
}
