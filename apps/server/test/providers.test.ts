import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ModelList, Settings } from '@nicotes/shared';
import { chat, streamChat } from '../src/ai/llm.js';
import { listModels } from '../src/ai/models.js';
import { checkRouteway } from '../src/settings.js';
import { linksInText } from '../src/ai/research.js';
import { setup } from './helpers.js';

const routewayCatalog = {
  data: [
    {
      id: 'deepseek-v4.1-flash',
      name: 'DeepSeek: V4.1 Flash',
      context_length: 1_048_576,
      available: true,
      endpoints: ['/v1/chat/completions'],
      pricing: { input: { price_per_million_t: 0.5 }, output: { price_per_million_t: 2 } },
      capabilities: { function_call: true, reasoning: true },
    },
    { id: 'flux-2', name: 'Flux 2', available: true, endpoints: ['/v1/images/generations'] },
    { id: 'gone', name: 'Gone', available: false, endpoints: ['/v1/chat/completions'] },
  ],
};
const openRouterCatalog = {
  data: [
    { id: 'z-ai/glm-5.3-flashx', name: 'GLM 5.3 FlashX', context_length: 200_000, pricing: { prompt: '0.0000001', completion: '0.0000004' }, supported_parameters: ['tools'] },
    { id: 'meta/llama:free', name: 'Llama (free)', pricing: { prompt: '0', completion: '0' } },
  ],
};

interface Call {
  url: string;
  auth: string | null;
  body: Record<string, unknown> | null;
}

/** Fake fetch: model catalogs, plus chat completions answered by `reply`. */
function fakeServices(reply: (call: Call) => Response) {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === 'https://api.routeway.ai/v1/models') return Response.json(routewayCatalog);
    if (url === 'https://openrouter.ai/api/v1/models') return Response.json(openRouterCatalog);
    const call = {
      url,
      auth: new Headers(init?.headers).get('authorization'),
      body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null,
    };
    calls.push(call);
    return reply(call);
  });
  return calls;
}

const keys = { openrouter: 'sk-or', routeway: 'sk-rw' };

describe('model services', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('sends "routeway:" models to Routeway with its key and options, and prices them from its list', async () => {
    const calls = fakeServices(() =>
      Response.json({ choices: [{ message: { content: 'Hi' } }], usage: { prompt_tokens: 1_000_000, completion_tokens: 500_000 } }),
    );
    const reply = await chat({ keys, model: 'routeway:deepseek-v4.1-flash', messages: [{ role: 'user', content: 'Hello' }], maxTokens: 50, json: true });
    expect(calls[0]!.url).toBe('https://api.routeway.ai/v1/chat/completions');
    expect(calls[0]!.auth).toBe('Bearer sk-rw');
    expect(calls[0]!.body).toMatchObject({ model: 'deepseek-v4.1-flash', max_tokens: 50, response_format: { type: 'json_object' } });
    // OpenRouter-only options stay out; reasoning stays off by default.
    expect(calls[0]!.body).not.toHaveProperty('reasoning');
    expect(calls[0]!.body).not.toHaveProperty('usage');
    expect(reply.usage.cost).toBeCloseTo(0.5 + 1); // 1M in × $0.50 + 0.5M out × $2
  });

  it('keeps OpenRouter models on OpenRouter', async () => {
    const calls = fakeServices(() => Response.json({ choices: [{ message: { content: 'Hi' } }], usage: { cost: 0.002 } }));
    const reply = await chat({ keys, model: 'z-ai/glm-5.3-flashx', messages: [{ role: 'user', content: 'Hi' }], maxTokens: 50, webResults: 3 });
    expect(calls[0]!.url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(calls[0]!.auth).toBe('Bearer sk-or');
    expect(calls[0]!.body).toMatchObject({ model: 'z-ai/glm-5.3-flashx', reasoning: { effort: 'minimal' }, plugins: [{ id: 'web', max_results: 3 }] });
    expect(reply.usage.cost).toBe(0.002);
  });

  it('searches with "@online" and streams with usage on Routeway', async () => {
    const calls = fakeServices((call) => {
      if (!call.body?.stream) return Response.json({ choices: [{ message: { content: 'x' } }] });
      const sse = ['data: {"choices":[{"delta":{"content":"Hel"}}]}', 'data: {"choices":[{"delta":{"content":"lo"}}],"usage":{"prompt_tokens":10,"completion_tokens":2}}', 'data: [DONE]'];
      return new Response(sse.join('\n\n'), { headers: { 'content-type': 'text/event-stream' } });
    });
    await chat({ keys, model: 'routeway:deepseek-v4.1-flash', messages: [{ role: 'user', content: 'News?' }], maxTokens: 50, webResults: 5 });
    expect(calls[0]!.body).toMatchObject({ model: 'deepseek-v4.1-flash@online' });

    const pieces: string[] = [];
    const streamed = await streamChat({ keys, model: 'routeway:deepseek-v4.1-flash', messages: [{ role: 'user', content: 'Hi' }], maxTokens: 50 }, (t) => pieces.push(t));
    expect(calls[1]!.body).toMatchObject({ stream: true, stream_options: { include_usage: true } });
    expect(pieces.join('')).toBe('Hello');
    expect(streamed.usage).toMatchObject({ promptTokens: 10, completionTokens: 2 });
  });

  it('streams plain completions so long answers start before Cloudflare gives up', async () => {
    const calls = fakeServices(() => {
      const sse = [': ROUTEWAY PROCESSING', 'data: {"choices":[{"delta":{"content":"{\\"a\\":"}}]}', 'data: {"choices":[{"delta":{"content":"1}"}}],"usage":{"prompt_tokens":5,"completion_tokens":3}}', 'data: [DONE]'];
      return new Response(sse.join('\n\n'), { headers: { 'content-type': 'text/event-stream' } });
    });
    const reply = await chat({ keys, model: 'routeway:deepseek-v4.1-flash', messages: [{ role: 'user', content: 'JSON' }], maxTokens: 50, json: true, effort: 'high' });
    expect(calls[0]!.body).toMatchObject({ stream: true, response_format: { type: 'json_object' }, reasoning_effort: 'high' });
    expect(reply).toMatchObject({ content: '{"a":1}', citations: [], usage: { promptTokens: 5, completionTokens: 3 } });
  });

  it('explains a gateway timeout', async () => {
    fakeServices(() => new Response('<html>A timeout occurred</html>', { status: 524 }));
    await expect(chat({ keys, model: 'routeway:deepseek-v4.1-flash', messages: [{ role: 'user', content: 'Long' }], maxTokens: 50 })).rejects.toThrow(
      'Routeway timed out waiting for the model (HTTP 524)',
    );
  });

  it('names the missing key and the service in errors', async () => {
    fakeServices(() => Response.json({ error: { message: 'bad key' } }, { status: 401 }));
    await expect(chat({ keys: { openrouter: 'sk-or', routeway: null }, model: 'routeway:x', messages: [], maxTokens: 1 })).rejects.toThrow(
      'No Routeway API key configured (Settings)',
    );
    await expect(chat({ keys, model: 'routeway:x', messages: [], maxTokens: 1 })).rejects.toThrow('Routeway rejected the API key');
  });

  it('lists chat models of both services, prefixing Routeway ids and skipping unusable ones', async () => {
    fakeServices(() => new Response(null, { status: 500 }));
    const { models, errors } = await listModels('chat', true);
    expect(errors).toEqual([]);
    expect(models.map((m) => m.id).sort()).toEqual(['meta/llama:free', 'routeway:deepseek-v4.1-flash', 'z-ai/glm-5.3-flashx']);
    expect(models.find((m) => m.provider === 'routeway')).toMatchObject({
      name: 'DeepSeek: V4.1 Flash',
      promptPrice: 0.5,
      completionPrice: 2,
      contextLength: 1_048_576,
      tools: true,
      reasoning: true,
      free: false,
    });
    expect(models.find((m) => m.id === 'meta/llama:free')).toMatchObject({ provider: 'openrouter', free: true, tools: false });
  });

  it('still lists one service when the other is down', async () => {
    vi.stubGlobal('fetch', async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input);
      return url.includes('routeway') ? new Response(null, { status: 503 }) : Response.json(openRouterCatalog);
    });
    const { models, errors } = await listModels('chat', true);
    expect(models.every((m) => m.provider === 'openrouter')).toBe(true);
    expect(errors).toEqual(['Routeway answered 503']);
  });

  it('finds links in a search reply without citations', () => {
    expect(linksInText('1. [Sourdough guide](https://example.com/guide) — basics\n2. See https://bread.example.org/rye.')).toEqual([
      { url: 'https://example.com/guide', title: 'Sourdough guide', snippet: '' },
      { url: 'https://bread.example.org/rye', title: 'https://bread.example.org/rye', snippet: '' },
    ]);
  });
});

describe('Routeway settings', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('stores the key encrypted, reports it as set, and serves the merged model list', async () => {
    const api = setup();
    await api.call('POST', '/api/auth/setup', { username: 'nico', password: 'secret-pass' });
    expect((await api.call<Settings>('GET', '/api/settings')).body.routeway).toEqual({ apiKeySet: false, apiKeySource: null });
    const saved = await api.call<Settings>('PATCH', '/api/settings', { routewayApiKey: 'sk-rw-secret' });
    expect(saved.body.routeway).toEqual({ apiKeySet: true, apiKeySource: 'settings' });
    expect(JSON.stringify(saved.body)).not.toContain('sk-rw-secret');

    fakeServices(() => new Response(null, { status: 500 }));
    const list = await api.call<ModelList>('GET', '/api/settings/models?kind=chat&refresh=1');
    expect(list.body.models.some((m) => m.id === 'routeway:deepseek-v4.1-flash')).toBe(true);
  });

  it('asks for the key of the service the feature uses', async () => {
    const api = setup({ settingsEnv: { openrouterApiKey: 'sk-or' } as never });
    await api.call('POST', '/api/auth/setup', { username: 'nico', password: 'secret-pass' });
    await api.call('PATCH', '/api/settings', { askModel: 'routeway:deepseek-v4.1-flash' });
    const res = await api.rawPost('/api/ai/ask', { question: 'Anything new?' });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('Asking needs a Routeway API key');
  });
});

describe('Routeway connection check', () => {
  afterEach(() => vi.unstubAllGlobals());

  /** Routeway as observed: chat requests authenticate first; the balance needs an account key. */
  function fakeRouteway(validKey: string) {
    const urls: string[] = [];
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      urls.push(url);
      const auth = new Headers(init?.headers).get('authorization');
      if (url.endsWith('/v1/chat/completions')) {
        if (!auth) return new Response(null, { status: 403 });
        if (auth !== `Bearer ${validKey}`) return Response.json({ error: { message: 'Invalid API key' } }, { status: 401 });
        return Response.json({ error: { message: 'List should have at least 1 item' } }, { status: 422 });
      }
      if (url.endsWith('/v1/account/balance')) return Response.json({ error: { message: 'Invalid account key' } }, { status: 401 });
      throw new Error(`unexpected request to ${url}`);
    });
    return urls;
  }

  it('accepts an ordinary API key that may not read the balance', async () => {
    const urls = fakeRouteway('sk-good');
    expect(await checkRouteway('sk-good')).toEqual({ ok: true, message: 'The key works' });
    expect(urls[0]).toBe('https://api.routeway.ai/v1/chat/completions');
  });

  it('rejects a wrong key', async () => {
    fakeRouteway('sk-good');
    expect(await checkRouteway('sk-bad')).toEqual({ ok: false, message: 'Routeway rejected the API key' });
    expect(await checkRouteway(null)).toEqual({ ok: false, message: 'No API key configured' });
  });
});
