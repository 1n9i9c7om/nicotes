import type { z } from 'zod';

export class LlmError extends Error {}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  /** USD as reported by OpenRouter (0 if unknown). */
  cost: number;
}

export const addUsage = (a: Usage, b: Usage): Usage => ({
  promptTokens: a.promptTokens + b.promptTokens,
  completionTokens: a.completionTokens + b.completionTokens,
  cost: a.cost + b.cost,
});

export const emptyUsage = (): Usage => ({ promptTokens: 0, completionTokens: 0, cost: 0 });

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
  apiKey: string;
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
  /** OpenRouter's web search plugin, returning sources as citations. */
  webResults?: number;
  signal?: AbortSignal;
}

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';

export async function chat(opts: ChatOptions): Promise<{ content: string; usage: Usage; citations: Citation[] }> {
  const body = {
    model: opts.model,
    messages: opts.messages,
    // JSON mode; schemas are described in the prompt and validated by the caller, since
    // not every model supports strict structured outputs.
    ...(opts.json ? { response_format: { type: 'json_object' } } : {}),
    temperature: 0.2,
    max_tokens: opts.maxTokens,
    reasoning: { effort: opts.effort ?? 'minimal', exclude: true },
    usage: { include: true },
    ...(opts.webResults ? { plugins: [{ id: 'web', max_results: opts.webResults }] } : {}),
  };

  const send = async (payload: object) => {
    try {
      return await fetch(ENDPOINT, {
        method: 'POST',
        signal: opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(180_000)]) : AbortSignal.timeout(180_000),
        headers: { authorization: `Bearer ${opts.apiKey}`, 'content-type': 'application/json', 'x-title': 'Nicotes' },
        body: JSON.stringify(payload),
      });
    } catch (error) {
      if (opts.signal?.aborted) throw new LlmError('Cancelled');
      const timeout = (error as Error).name === 'TimeoutError';
      throw new LlmError(timeout ? 'The model took too long to answer' : `Cannot reach OpenRouter: ${(error as Error).message}`);
    }
  };

  let res = await send(body);
  let data = (await res.json().catch(() => ({}))) as CompletionResponse;
  if (res.status === 400 && /reasoning|effort/i.test(data.error?.message ?? '')) {
    const { reasoning: _unused, ...withoutReasoning } = body;
    res = await send(withoutReasoning);
    data = (await res.json().catch(() => ({}))) as CompletionResponse;
  }
  if (!res.ok) {
    const reason = data.error?.message ?? `HTTP ${res.status}`;
    if (res.status === 401) throw new LlmError('OpenRouter rejected the API key');
    if (res.status === 402) throw new LlmError('Your OpenRouter credits are used up');
    if (res.status === 429) throw new LlmError('OpenRouter rate limit reached, try again shortly');
    throw new LlmError(`OpenRouter error: ${reason}`);
  }
  const message = data.choices?.[0]?.message;
  return {
    content: message?.content ?? '',
    usage: {
      promptTokens: data.usage?.prompt_tokens ?? 0,
      completionTokens: data.usage?.completion_tokens ?? 0,
      cost: data.usage?.cost ?? 0,
    },
    citations: (message?.annotations ?? [])
      .filter((a) => a.type === 'url_citation' && a.url_citation?.url)
      .map((a) => ({ url: a.url_citation!.url, title: a.url_citation!.title ?? '', content: a.url_citation!.content ?? '' })),
  };
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
  apiKey: string;
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
      apiKey: opts.apiKey,
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
