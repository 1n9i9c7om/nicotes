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

/**
 * How to reach each service: an API key for the hosted ones, an address (and a key, if it
 * wants one) for your own server. A model's id decides which one is used (see `providerOf`).
 */
export interface ProviderKeys {
  openrouter: string | null;
  routeway: string | null;
  local: { url: string; key: string | null } | null;
}

/** Whether the service that runs `model` is set up. */
export const hasKeyFor = (keys: ProviderKeys, model: string) => !!keys[providerOf(model)];

/** E.g. "Asking needs a Routeway API key — add one under Settings." */
export function missingKeyMessage(what: string, model: string) {
  const provider = providerOf(model);
  if (provider === 'local') return `${what} needs the address of your own model server — add it under Settings.`;
  return `${what} needs ${provider === 'routeway' ? 'a Routeway' : 'an OpenRouter'} API key — add one under Settings.`;
}

/** Text, or text and images (as data: URLs) for models that accept images. */
export type ContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | ContentPart[];
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

const ENDPOINTS: Record<Exclude<AiProvider, 'local'>, string> = {
  openrouter: 'https://openrouter.ai/api/v1/chat/completions',
  routeway: 'https://api.routeway.ai/v1/chat/completions',
};

interface Route {
  provider: AiProvider;
  label: string;
  url: string;
  /** Your own server may need none. */
  key: string | null;
  model: string;
}

/** The service that runs a model, where to send it, its key and the model id it expects. */
function route(opts: Pick<ChatOptions, 'keys' | 'model' | 'webResults'>): Route {
  const provider = providerOf(opts.model);
  const id = providerModelId(opts.model);
  if (provider === 'local') {
    const local = opts.keys.local;
    if (!local) throw new LlmError('No address of your own model server configured (Settings)');
    if (opts.webResults) {
      throw new LlmError('Your own model server cannot search the web: set up SearXNG under Settings, or research from the model’s own knowledge');
    }
    return { provider, label: 'your model server', url: `${local.url}/chat/completions`, key: local.key, model: id };
  }
  const label = AI_PROVIDER_LABELS[provider];
  const key = opts.keys[provider];
  if (!key) throw new LlmError(`No ${label} API key configured (Settings)`);
  return { provider, label, url: ENDPOINTS[provider], key, model: provider === 'routeway' && opts.webResults ? `${id}@online` : id };
}

const headersFor = (r: Route) => ({
  ...(r.key ? { authorization: `Bearer ${r.key}` } : {}),
  'content-type': 'application/json',
  'x-title': 'Nicotes',
});

/**
 * The request body. OpenRouter has its own reasoning, usage and web search options;
 * Routeway and your own server take the plain OpenAI ones.
 */
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

/**
 * A simpler request for a model that refused one: without reasoning options, and without
 * JSON mode if that was the problem (some servers only take JSON schemas). Null if the
 * refusal was about something else.
 */
function fallbackBody(body: object, message: string | undefined): object | null {
  if (/reasoning|effort/i.test(message ?? '')) return withoutReasoning(body);
  if (/response_format|json/i.test(message ?? '') && 'response_format' in body) {
    const { response_format: _, ...rest } = withoutReasoning(body) as Record<string, unknown>;
    return rest;
  }
  return null;
}

function httpError(r: Route, status: number, message?: string): LlmError {
  if (status === 404 && r.provider === 'local') {
    return new LlmError(`Your model server does not know the model "${r.model}" (or its address is wrong): ${message ?? 'HTTP 404'}`);
  }
  if (status === 401) return new LlmError(`${r.label} rejected the API key`);
  if (status === 402) return new LlmError(`Your ${r.label} credits are used up`);
  if (status === 429) return new LlmError(`${r.label} rate limit reached, try again shortly`);
  // 524 is Cloudflare's: the service did not start answering within 100 seconds.
  if (status === 504 || status === 524) return new LlmError(`${r.label} timed out waiting for the model (HTTP ${status})`);
  return new LlmError(`${r.label} error: ${message ?? `HTTP ${status}`}`);
}

async function usageOf(r: Route, model: string, raw?: CompletionResponse['usage']): Promise<Usage> {
  const promptTokens = raw?.prompt_tokens ?? 0;
  const completionTokens = raw?.completion_tokens ?? 0;
  const cost = r.provider === 'openrouter' ? (raw?.cost ?? 0) : await estimateCost(model, promptTokens, completionTokens);
  return { promptTokens, completionTokens, cost };
}

/**
 * One chat completion. Streamed unless it searches the web (citations only arrive with the
 * whole answer): the services sit behind Cloudflare, which cuts a request off (HTTP 524) when
 * the answer has not started after 100 seconds, as with long notes from a reasoning model.
 */
export async function chat(opts: ChatOptions): Promise<{ content: string; usage: Usage; citations: Citation[] }> {
  if (!opts.webResults) return { ...(await streamChat(opts, () => {})), citations: [] };
  const r = route(opts);
  const body = requestBody(r, opts, false);

  const send = async (payload: object) => {
    try {
      return await fetch(r.url, {
        method: 'POST',
        signal: opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(180_000)]) : AbortSignal.timeout(180_000),
        headers: headersFor(r),
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
  const simpler = res.status === 400 ? fallbackBody(body, data.error?.message) : null;
  if (simpler) {
    res = await send(simpler);
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

/** A function the model may call, its parameters described by a JSON schema. */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: object;
}

export interface ToolCall {
  id: string;
  name: string;
  /** JSON, as the model wrote it (may be invalid). */
  arguments: string;
}

/** A conversation with tools: the model's calls, and their results sent back. */
export type ToolMessage =
  | ChatMessage
  | { role: 'assistant'; content: string | null; tool_calls: { id: string; type: 'function'; function: { name: string; arguments: string } }[] }
  | { role: 'tool'; tool_call_id: string; content: string };

interface ToolCompletion {
  choices?: { message?: { content?: string | null; tool_calls?: { id: string; function: { name: string; arguments?: string } }[] } }[];
  usage?: CompletionResponse['usage'];
  error?: { message?: string };
}

/**
 * One completion that may call tools. Not streamed: calls arrive as a whole, and the caller
 * runs them and asks again with their results.
 */
export async function chatWithTools(
  opts: Omit<ChatOptions, 'messages' | 'json' | 'webResults'> & {
    messages: ToolMessage[];
    tools: ToolSpec[];
    /**
     * "none": answer now, no more calls (the tools stay listed, as earlier calls refer to them).
     * "required": call at least one tool first; where the service can't, the model decides.
     */
    toolChoice?: 'auto' | 'none' | 'required';
  },
): Promise<{ content: string; toolCalls: ToolCall[]; usage: Usage }> {
  const r = route(opts);
  const body = {
    ...requestBody(r, { ...opts, messages: opts.messages as ChatMessage[] }, false),
    tools: opts.tools.map((t) => ({ type: 'function', function: t })),
    tool_choice: opts.toolChoice ?? 'auto',
  };
  const send = async (payload: object) => {
    try {
      return await fetch(r.url, {
        method: 'POST',
        signal: opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(180_000)]) : AbortSignal.timeout(180_000),
        headers: headersFor(r),
        body: JSON.stringify(payload),
      });
    } catch (error) {
      if (opts.signal?.aborted) throw new LlmError('Cancelled');
      const timeout = (error as Error).name === 'TimeoutError';
      throw new LlmError(timeout ? 'The model took too long to answer' : `Cannot reach ${r.label}: ${(error as Error).message}`);
    }
  };
  let res = await send(body);
  let data = (await res.json().catch(() => ({}))) as ToolCompletion;
  // Not every model server (or OpenRouter provider) takes "required".
  if ((res.status === 400 || res.status === 404) && body.tool_choice === 'required') {
    body.tool_choice = 'auto';
    res = await send(body);
    data = (await res.json().catch(() => ({}))) as ToolCompletion;
  }
  const simpler = res.status === 400 ? fallbackBody(body, data.error?.message) : null;
  if (simpler) {
    res = await send(simpler);
    data = (await res.json().catch(() => ({}))) as ToolCompletion;
  }
  if (!res.ok) {
    // OpenRouter answers 404 when no provider of the model supports tools.
    if (/tool/i.test(data.error?.message ?? '') && (res.status === 400 || res.status === 404)) {
      throw new LlmError(`The model ${opts.model} cannot use tools, which the chat needs: choose another one for Chat under Settings → AI models`);
    }
    throw httpError(r, res.status, data.error?.message);
  }
  const message = data.choices?.[0]?.message;
  return {
    content: message?.content ?? '',
    toolCalls: (message?.tool_calls ?? []).map((c) => ({ id: c.id, name: c.function.name, arguments: c.function.arguments ?? '{}' })),
    usage: await usageOf(r, opts.model, data.usage),
  };
}

/** A stream fails after this long without any data, and after MAX_STREAM_MS in total. */
const IDLE_MS = 120_000;
const MAX_STREAM_MS = 600_000;

/**
 * A chat completion streamed token by token (`onDelta` gets each piece of text). Returns the
 * full text and the usage reported in the last event.
 */
export async function streamChat(
  opts: Omit<ChatOptions, 'webResults'>,
  onDelta: (text: string) => void,
): Promise<{ content: string; usage: Usage }> {
  const r = route(opts);
  const body = requestBody(r, opts, true);
  // Long answers may take minutes in total, so the limit is on silence rather than duration.
  const idle = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const alive = () => {
    clearTimeout(timer);
    timer = setTimeout(() => idle.abort(new DOMException('No data from the model', 'TimeoutError')), IDLE_MS);
  };
  alive();
  const signal = AbortSignal.any([idle.signal, AbortSignal.timeout(MAX_STREAM_MS), ...(opts.signal ? [opts.signal] : [])]);
  try {
    return await readStream(r, opts, body, signal, alive, onDelta);
  } catch (error) {
    if (error instanceof LlmError) throw error;
    if (opts.signal?.aborted) throw new LlmError('Cancelled');
    if ((error as Error).name === 'TimeoutError') throw new LlmError('The model took too long to answer');
    throw new LlmError(`The answer was interrupted: ${(error as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
}

async function readStream(
  r: Route,
  opts: Omit<ChatOptions, 'webResults'>,
  body: object,
  signal: AbortSignal,
  alive: () => void,
  onDelta: (text: string) => void,
): Promise<{ content: string; usage: Usage }> {
  const send = (payload: object) => fetch(r.url, { method: 'POST', signal, headers: headersFor(r), body: JSON.stringify(payload) });

  let res: Response;
  try {
    res = await send(body);
    if (res.status === 400) {
      const error = (await res.clone().json().catch(() => ({}))) as CompletionResponse;
      const simpler = fallbackBody(body, error.error?.message);
      if (simpler) res = await send(simpler);
    }
  } catch (error) {
    if (opts.signal?.aborted || (error as Error).name === 'TimeoutError') throw error;
    throw new LlmError(`Cannot reach ${r.label}: ${(error as Error).message}`);
  }
  if (!res.ok || !res.body) {
    const data = (await res.json().catch(() => ({}))) as CompletionResponse;
    throw httpError(r, res.status, data.error?.message);
  }
  // Answered as a whole after all (a service may ignore "stream").
  if (!res.headers.get('content-type')?.includes('event-stream')) {
    const data = (await res.json().catch(() => ({}))) as CompletionResponse;
    const whole = data.choices?.[0]?.message?.content ?? '';
    if (whole) onDelta(whole);
    return { content: whole, usage: await usageOf(r, opts.model, data.usage) };
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
  for await (const bytes of res.body as unknown as AsyncIterable<Uint8Array>) {
    // Keep-alive comments count too: the model is still working.
    alive();
    buffer += decoder.decode(bytes, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) handle(line);
  }
  handle(buffer);
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
