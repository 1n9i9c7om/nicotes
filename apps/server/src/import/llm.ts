import type { z } from 'zod';

export class LlmError extends Error {}

interface Usage {
  promptTokens: number;
  completionTokens: number;
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface CompletionResponse {
  choices?: { message?: { content?: string | null } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string };
}

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';

async function chat(apiKey: string, model: string, messages: ChatMessage[], maxTokens: number) {
  let res: Response;
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      signal: AbortSignal.timeout(120_000),
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
        'x-title': 'Nicotes',
      },
      body: JSON.stringify({
        model,
        messages,
        // JSON mode; the schema itself is described in the prompt and validated below,
        // since not every model supports strict structured outputs.
        response_format: { type: 'json_object' },
        temperature: 0.2,
        max_tokens: maxTokens,
        reasoning: { effort: 'low', exclude: true },
      }),
    });
  } catch (error) {
    const timeout = (error as Error).name === 'TimeoutError';
    throw new LlmError(timeout ? 'The model took too long to answer' : `Cannot reach OpenRouter: ${(error as Error).message}`);
  }
  const body = (await res.json().catch(() => ({}))) as CompletionResponse;
  if (!res.ok) {
    const reason = body.error?.message ?? `HTTP ${res.status}`;
    if (res.status === 401) throw new LlmError('OpenRouter rejected the API key');
    if (res.status === 402) throw new LlmError('Your OpenRouter credits are used up');
    if (res.status === 429) throw new LlmError('OpenRouter rate limit reached, try again shortly');
    throw new LlmError(`OpenRouter error: ${reason}`);
  }
  return {
    content: body.choices?.[0]?.message?.content ?? '',
    usage: { promptTokens: body.usage?.prompt_tokens ?? 0, completionTokens: body.usage?.completion_tokens ?? 0 },
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
}): Promise<{ data: z.infer<S>; usage: Usage }> {
  const messages: ChatMessage[] = [
    { role: 'system', content: opts.system },
    { role: 'user', content: opts.user },
  ];
  const usage: Usage = { promptTokens: 0, completionTokens: 0 };
  let problem = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    const reply = await chat(opts.apiKey, opts.model, messages, opts.maxTokens ?? 4000);
    usage.promptTokens += reply.usage.promptTokens;
    usage.completionTokens += reply.usage.completionTokens;
    try {
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
