import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { ImportPreview, Settings } from '@nicotes/shared';
import { cleanTitle } from '../src/import/extract.js';
import { completeJson, parseJsonReply } from '../src/import/llm.js';
import { isPrivateAddress, safeFetch } from '../src/import/net.js';
import { findStructured, isoDuration, recipeFromJsonLd } from '../src/import/structured.js';
import { SecretBox } from '../src/secrets.js';
import { setup } from './helpers.js';

const RECIPE_LD = {
  '@context': 'https://schema.org',
  '@graph': [
    { '@type': 'WebSite', name: 'Test Kitchen' },
    {
      '@type': ['Recipe'],
      name: 'Apfelkuchen &amp; Streusel',
      description: '<p>Saftiger Kuchen</p>',
      recipeYield: ['12', '12 Stücke'],
      prepTime: 'PT30M',
      cookTime: 'PT1H5M',
      image: { '@type': 'ImageObject', url: '/cover.png' },
      recipeIngredient: ['200 g Mehl', '3 Äpfel', '100&nbsp;g Butter'],
      recipeInstructions: [
        { '@type': 'HowToSection', name: 'Teig', itemListElement: [{ '@type': 'HowToStep', text: 'Mehl und Butter verkneten.' }] },
        { '@type': 'HowToSection', name: 'Belag', itemListElement: [{ '@type': 'HowToStep', text: '1. Äpfel schneiden.' }] },
      ],
    },
  ],
};

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

describe('SecretBox', () => {
  it('round-trips and refuses foreign keys', () => {
    const box = SecretBox.fromSecret('one');
    const sealed = box.encrypt('sk-or-123');
    expect(sealed).not.toContain('sk-or-123');
    expect(box.decrypt(sealed)).toBe('sk-or-123');
    expect(SecretBox.fromSecret('two').decrypt(sealed)).toBeNull();
  });
});

describe('network guard', () => {
  it('classifies private and public addresses', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.0.10', '172.20.0.1', '169.254.1.1', '100.64.0.1', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1', '0.0.0.0']) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ['1.1.1.1', '93.184.216.34', '2a00:6020:b42d:d400::1', '::ffff:8.8.8.8']) {
      expect(isPrivateAddress(ip), ip).toBe(false);
    }
  });

  it('refuses private hosts, odd schemes and credentials', async () => {
    const opts = { allowPrivate: false, maxBytes: 1000, timeoutMs: 5000 };
    await expect(safeFetch('http://127.0.0.1:1/', opts)).rejects.toThrow(/Private network/);
    await expect(safeFetch('http://[::1]/', opts)).rejects.toThrow(/Private network/);
    await expect(safeFetch('http://localhost/', opts)).rejects.toThrow(/private network/);
    await expect(safeFetch('file:///etc/passwd', opts)).rejects.toThrow(/http/);
    await expect(safeFetch('http://user:pw@example.com/', opts)).rejects.toThrow(/credentials/);
  });
});

describe('structured data', () => {
  it('maps a schema.org recipe with sections, durations and entities', () => {
    const found = findStructured([RECIPE_LD]);
    expect(found?.profile).toBe('recipe');
    expect(recipeFromJsonLd(found!.node)).toEqual({
      title: 'Apfelkuchen & Streusel',
      description: 'Saftiger Kuchen',
      servings: '12',
      prepTime: '30 min',
      cookTime: '1 h 5 min',
      totalTime: null,
      ingredients: [{ section: null, items: ['200 g Mehl', '3 Äpfel', '100 g Butter'] }],
      steps: [
        { section: 'Teig', items: ['Mehl und Butter verkneten.'] },
        { section: 'Belag', items: ['Äpfel schneiden.'] },
      ],
      notes: [],
    });
    expect(isoDuration('P0DT2H0M')).toBe('2 h');
  });
});

describe('cleanTitle', () => {
  it('strips site suffixes but keeps real subtitles', () => {
    expect(cleanTitle('Factorio - Wikipedia', null, 'https://en.wikipedia.org/wiki/Factorio')).toBe('Factorio');
    expect(cleanTitle('Apfelkuchen | Chefkoch', 'Chefkoch', 'https://www.chefkoch.de/x')).toBe('Apfelkuchen');
    expect(cleanTitle('Elden Ring: Nightreign', null, 'https://example.com/')).toBe('Elden Ring: Nightreign');
  });
});

describe('LLM client', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('parses JSON wrapped in fences or chatter', () => {
    expect(parseJsonReply('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseJsonReply('Sure! {"a":2} Hope that helps')).toEqual({ a: 2 });
  });

  it('retries once when the reply does not match the schema', async () => {
    const replies = ['{"title": 5}', '{"title": "Fixed"}'];
    const bodies: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)));
        return new Response(
          JSON.stringify({ choices: [{ message: { content: replies.shift() } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }),
          { status: 200 },
        );
      }),
    );
    const result = await completeJson({ apiKey: 'k', model: 'm', system: 's', user: 'u', schema: z.object({ title: z.string() }) });
    expect(result.data).toEqual({ title: 'Fixed' });
    expect(result.usage).toEqual({ promptTokens: 20, completionTokens: 10 });
    expect((bodies[1] as { messages: unknown[] }).messages).toHaveLength(4);
    expect(bodies[0]).toMatchObject({ model: 'm', response_format: { type: 'json_object' } });
  });
});

describe('settings and import API', () => {
  let server: Server;
  let base = '';

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === '/cover.png') {
        res.writeHead(200, { 'content-type': 'image/png' }).end(PNG);
        return;
      }
      if (req.url === '/redirect') {
        res.writeHead(302, { location: '/recipe' }).end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(`<!doctype html><html><head>
        <title>Apfelkuchen | Test Kitchen</title><meta property="og:site_name" content="Test Kitchen">
        <script type="application/ld+json">${JSON.stringify(RECIPE_LD)}</script></head>
        <body><nav>Menu</nav><article><h1>Apfelkuchen</h1><p>${'Ein sehr guter Kuchen. '.repeat(40)}</p></article></body></html>`);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => server.close());

  async function signedIn(allowPrivate: boolean) {
    const api = setup({ importAllowPrivate: allowPrivate });
    await api.call('POST', '/api/auth/setup', { username: 'nico', password: 'secret-pass' });
    return api;
  }

  it('stores settings without ever returning secrets', async () => {
    const api = await signedIn(false);
    let view = (await api.call<Settings>('GET', '/api/settings')).body;
    expect(view.openrouter).toEqual({ apiKeySet: false, apiKeySource: null, model: 'z-ai/glm-5.3-flashx', modelSource: 'default' });

    const updated = await api.call<Settings>('PATCH', '/api/settings', {
      openrouterApiKey: 'sk-or-secret',
      openrouterModel: 'z-ai/glm-5.3',
      crawl4aiUrl: 'http://crawl4ai:11235',
    });
    expect(JSON.stringify(updated.body)).not.toContain('sk-or-secret');
    expect(updated.body.openrouter).toMatchObject({ apiKeySet: true, apiKeySource: 'settings', model: 'z-ai/glm-5.3' });
    expect(updated.body.crawl4ai).toMatchObject({ url: 'http://crawl4ai:11235', tokenSet: false });

    const stored = api.db.$client.prepare("SELECT value FROM settings WHERE key = 'openrouter.apiKey'").get() as { value: string };
    expect(stored.value).toMatch(/^v1:/);
    expect(stored.value).not.toContain('sk-or-secret');

    view = (await api.call<Settings>('PATCH', '/api/settings', { openrouterModel: null, openrouterApiKey: '' })).body;
    expect(view.openrouter).toMatchObject({ apiKeySet: false, modelSource: 'default' });
    expect((await api.call('PATCH', '/api/settings', { crawl4aiUrl: 'ftp://x' })).status).toBe(400);
  });

  it('blocks private hosts unless explicitly allowed', async () => {
    const api = await signedIn(false);
    const res = await api.call<{ error: string }>('POST', '/api/import/preview', { url: `${base}/recipe` });
    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/Private network/);
  });

  it('imports a recipe from structured data without a model, including its cover image', async () => {
    const api = await signedIn(true);
    const res = await api.call<ImportPreview>('POST', '/api/import/preview', { url: `${base}/redirect` });
    expect(res.status).toBe(200);
    const p = res.body;
    expect(p).toMatchObject({
      profile: 'recipe',
      title: 'Apfelkuchen & Streusel',
      method: 'structured-data',
      extractor: 'readability',
      suggestedTags: ['recipe'],
      source: { url: `${base}/recipe`, siteName: 'Test Kitchen' },
      usage: null,
    });
    expect(p.markdown).toMatch(/^!\[Apfelkuchen & Streusel\]\(\/api\/attachments\/[\w-]+\/cover\.png\)/);
    expect(p.markdown).toContain('**Servings:** 12 · **Prep:** 30 min · **Cook:** 1 h 5 min');
    expect(p.markdown).toContain('## Ingredients\n\n- [ ] 200 g Mehl\n- [ ] 3 Äpfel\n- [ ] 100 g Butter');
    expect(p.markdown).toContain('## Instructions\n\n### Teig\n\n1. Mehl und Butter verkneten.\n\n### Belag\n\n1. Äpfel schneiden.');
    expect(p.markdown).toContain(`Source: [Test Kitchen](${base}/recipe)`);

    const cover = await api.raw(/\((\/api\/attachments\/[^)]+)\)/.exec(p.markdown)![1]!);
    expect(cover.headers.get('content-type')).toBe('image/png');
  });

  it('clips pasted text when no API key is configured', async () => {
    const api = await signedIn(false);
    const res = await api.call<ImportPreview>('POST', '/api/import/preview', { text: '# Notizen\n\nEin paar Gedanken.' });
    expect(res.body).toMatchObject({ method: 'clip', extractor: 'text', title: 'Notizen' });
    expect(res.body.warnings[0]).toMatch(/No OpenRouter API key/);
    expect(res.body.markdown).toContain('Ein paar Gedanken.');
    expect((await api.call('POST', '/api/import/preview', {})).status).toBe(400);
  });
});
