import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Job, Notebook, OrganizeResult, Page, PageSummary, ResearchResult } from '@nicotes/shared';
import { canonicalUrl, linkCitations, pickSources } from '../src/ai/research.js';
import { setup } from './helpers.js';

/** Scripted OpenRouter: `reply` picks a response per request; other URLs go to the network. */
function fakeOpenRouter(reply: (prompt: string, body: Record<string, unknown>) => string, cost = 0.001) {
  const realFetch = globalThis.fetch;
  const calls: Record<string, unknown>[] = [];
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith('https://openrouter.ai/')) return realFetch(input, init);
    const body = JSON.parse(String(init?.body));
    calls.push(body);
    const prompt = (body.messages as { content: string }[]).map((m) => m.content).join('\n');
    return new Response(
      JSON.stringify({ choices: [{ message: { content: reply(prompt, body) } }], usage: { prompt_tokens: 100, completion_tokens: 50, cost } }),
      { status: 200 },
    );
  });
  return calls;
}

async function finished<T>(api: ReturnType<typeof setup>, id: string): Promise<Job<unknown, T>> {
  await api.jobs.idle();
  return (await api.call<Job<unknown, T>>('GET', `/api/jobs/${id}`)).body;
}

async function signedIn() {
  const api = setup({ settingsEnv: { openrouterApiKey: 'sk-test' } as never });
  await api.call('POST', '/api/auth/setup', { username: 'nico', password: 'secret-pass' });
  const nb = (await api.call<Notebook>('POST', '/api/notebooks', { title: 'Games' })).body;
  const create = async (title: string, content = '', parentId: string | null = null) =>
    (await api.call<Page>('POST', '/api/pages', { notebookId: nb.id, parentId, title, content })).body;
  return { api, nb, create };
}

afterEach(() => vi.unstubAllGlobals());

describe('research helpers', () => {
  it('dedupes, interleaves and limits sources per site', () => {
    const a = (url: string) => ({ url, title: url, snippet: '' });
    const picked = pickSources(
      [
        [a('https://x.com/1#top'), a('https://x.com/2'), a('https://x.com/3'), a('https://youtube.com/watch?v=1')],
        [a('https://x.com/1?utm_source=z'), a('https://y.org/a/')],
      ],
      10,
    );
    expect(picked.map((p) => p.url)).toEqual(['https://x.com/1#top', 'https://x.com/2', 'https://y.org/a/']);
    expect(canonicalUrl('https://y.org/a/?utm_medium=b#c')).toBe('https://y.org/a');
  });

  it('links citation markers without touching wikilinks or links', () => {
    const sources = [{ url: 'https://a.example' }, { url: 'https://b.example' }];
    expect(linkCitations('Fact [1]. Both [1, 2]. Bad [9]. [[Page]] and [x](y).', sources)).toBe(
      'Fact [1](https://a.example). Both [1](https://a.example), [2](https://b.example). Bad [9]. [[Page]] and [x](y).',
    );
  });
});

describe('organize', () => {
  it('suggests, validates, applies and undoes tags, moves and groups', async () => {
    const { api, nb, create } = await signedIn();
    const elden = await create('Elden Ring', 'Action RPG by FromSoftware.');
    const builds = await create('Builds', 'Strength build notes');
    const bosses = await create('Bosses', 'Malenia, Radahn');
    const items = await create('Items', 'Talismans');
    await api.call('PUT', `/api/pages/${elden.id}/tags`, { tags: ['gaming'] });

    fakeOpenRouter((prompt) => {
      expect(prompt).toContain('EXISTING TAGS: gaming (1)');
      const id = (title: string) => new RegExp(`(p\\d+) \\| ${title} \\|`).exec(prompt)![1];
      return JSON.stringify({
        tags: [
          { page: id('Elden Ring'), add: ['gaming', 'Open World'], reason: 'genre' },
          { page: 'p999', add: ['ghost'], reason: 'unknown page' },
        ],
        moves: [
          { page: id('Builds'), parent: id('Elden Ring'), reason: 'belongs to the game' },
          { page: id('Elden Ring'), parent: id('Elden Ring'), reason: 'invalid self move' },
        ],
        groups: [{ title: 'Elden Ring Guides', parent: null, pages: [id('Bosses'), id('Items')], reason: 'guides' }],
      });
    });

    const started = await api.call<Job>('POST', '/api/ai/organize', { scope: { kind: 'notebook', id: nb.id } });
    expect(started.status).toBe(202);
    const job = await finished<OrganizeResult>(api, started.body.id);
    expect(job.status).toBe('done');
    expect(job.cost).toBeCloseTo(0.001);
    const suggestions = job.result!.suggestions;
    expect(suggestions.map((s) => s.type).sort()).toEqual(['group', 'move', 'tag']);
    const tag = suggestions.find((s) => s.type === 'tag')!;
    expect(tag).toMatchObject({ tags: ['open-world'], newTags: ['open-world'] });

    const applied = await api.call<{ batchId: string }>('POST', `/api/ai/organize/${job.id}/apply`, {
      ids: suggestions.map((s) => s.id),
    });
    expect(applied.status).toBe(200);
    let tree = (await api.call<PageSummary[]>('GET', '/api/pages')).body;
    const byTitle = (t: string) => tree.find((p) => p.title === t)!;
    expect(byTitle('Elden Ring').tags).toEqual(['gaming', 'open-world']);
    expect(byTitle('Builds').parentId).toBe(elden.id);
    const group = byTitle('Elden Ring Guides');
    expect([byTitle('Bosses').parentId, byTitle('Items').parentId]).toEqual([group.id, group.id]);
    expect((await api.call('POST', `/api/ai/organize/${job.id}/apply`, { ids: [tag.id] })).status).toBe(409);

    expect((await api.call('POST', `/api/ai/batches/${applied.body.batchId}/undo`)).status).toBe(204);
    tree = (await api.call<PageSummary[]>('GET', '/api/pages')).body;
    expect(tree.map((p) => [p.title, p.parentId, p.tags]).sort()).toEqual(
      [
        ['Bosses', null, []],
        ['Builds', null, []],
        ['Elden Ring', null, ['gaming']],
        ['Items', null, []],
      ].sort(),
    );
    expect(tree.find((p) => p.title === 'Builds')!.sortOrder).toBeLessThan(tree.find((p) => p.title === 'Bosses')!.sortOrder);
    expect((await api.call('POST', `/api/ai/batches/${applied.body.batchId}/undo`)).status).toBe(409);
    void builds;
    void bosses;
    void items;
  });

  it('fails cleanly without an API key and respects the cost limit', async () => {
    const plain = setup();
    await plain.call('POST', '/api/auth/setup', { username: 'nico', password: 'secret-pass' });
    const nb = (await plain.call<Notebook>('POST', '/api/notebooks', { title: 'Games' })).body;
    const noKey = await plain.call<Job>('POST', '/api/ai/organize', { scope: { kind: 'notebook', id: nb.id } });
    expect((await finished(plain, noKey.body.id))).toMatchObject({ status: 'failed', error: expect.stringMatching(/API key/) });

    const { api, nb: nb2, create } = await signedIn();
    for (let i = 0; i < 35; i++) await create(`Page ${i}`);
    await api.call('PATCH', '/api/settings', { aiCostLimit: 0.01 });
    fakeOpenRouter(() => '{"tags":[],"moves":[],"groups":[]}', 0.02);
    const job = await api.call<Job>('POST', '/api/ai/organize', { scope: { kind: 'notebook', id: nb2.id } });
    expect(await finished(api, job.body.id)).toMatchObject({ status: 'failed', error: expect.stringMatching(/cost limit/) });
  });
});

describe('research', () => {
  let server: Server;
  let base = '';

  beforeAll(async () => {
    server = createServer((req, res) => {
      const url = new URL(req.url!, 'http://x');
      if (url.pathname === '/search') {
        const q = url.searchParams.get('q');
        res.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            results: [
              { url: `${base}/source-a`, title: 'Source A', content: 'snippet a' },
              { url: `${base}/source-b?utm_source=x`, title: 'Source B', content: `about ${q}` },
              { url: `${base}/broken`, title: 'Broken', content: 'x'.repeat(400) },
            ],
          }),
        );
        return;
      }
      if (url.pathname === '/broken') return void res.writeHead(500).end();
      const letter = url.pathname.slice(-1).toUpperCase();
      res.writeHead(200, { 'content-type': 'text/html' }).end(
        `<html><head><title>Source ${letter}</title></head><body><article><h1>Source ${letter}</h1><p>${`Main bus facts from ${letter}. `.repeat(30)}</p></article></body></html>`,
      );
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => server.close());

  beforeEach(() => vi.unstubAllGlobals());

  it('plans, searches SearXNG, reads sources and writes a cited note', async () => {
    const api = setup({ importAllowPrivate: true, settingsEnv: { openrouterApiKey: 'sk-test', searxngUrl: base } as never });
    await api.call('POST', '/api/auth/setup', { username: 'nico', password: 'secret-pass' });
    const nb = (await api.call<Notebook>('POST', '/api/notebooks', { title: 'Games' })).body;

    const calls = fakeOpenRouter((prompt) => {
      if (prompt.includes('You plan web research')) return '{"title":"Main bus","language":"en","queries":["factorio main bus","main bus ratios"]}';
      if (prompt.includes('take research notes')) {
        const letter = /Source: Source (\w)/.exec(prompt)?.[1] ?? '?';
        return JSON.stringify({ relevant: letter !== 'X', summary: `Summary of ${letter}`, facts: [`Fact from ${letter}`] });
      }
      return '# Ignored title\n\nThe bus carries plates [1]. Ratios differ [1, 2].\n\n## Open questions\n\nNone.';
    });

    const started = await api.call<Job>('POST', '/api/ai/research', { question: 'How to build a main bus?', depth: 'quick', notebookId: nb.id });
    const job = await finished<ResearchResult>(api, started.body.id);
    expect(job.error).toBeNull();
    expect(job.status).toBe('done');
    expect(job.result).toMatchObject({ title: 'Main bus', sources: 2, searchProvider: 'searxng' });
    expect(job.progress.log!.some((l) => l.startsWith('Searching (SearXNG)'))).toBe(true);

    const page = (await api.call<Page>('GET', `/api/pages/${job.result!.pageId}`)).body;
    expect(page.tags).toEqual(['research']);
    expect(page.content).toContain('> **Research question:** How to build a main bus?');
    expect(page.content).toContain(`The bus carries plates [1](${base}/source-a).`);
    expect(page.content).not.toContain('Ignored title');
    expect(page.content).toMatch(/## Sources\n\n1\. \[Source A\]\(.*\/source-a\) · /);
    // The synthesis step reasons a little more than extraction.
    expect(calls.at(-1)).toMatchObject({ reasoning: { effort: 'low' } });
  });

  it('writes an offline note from the model’s knowledge without searching', async () => {
    const api = setup({ importAllowPrivate: true, settingsEnv: { openrouterApiKey: 'sk-test', searxngUrl: base } as never });
    await api.call('POST', '/api/auth/setup', { username: 'nico', password: 'secret-pass' });
    const nb = (await api.call<Notebook>('POST', '/api/notebooks', { title: 'Games' })).body;
    let searched = false;
    const onRequest = () => (searched = true);
    server.on('request', onRequest);

    const calls = fakeOpenRouter((prompt) => {
      if (prompt.includes('You plan a research note')) return '{"title":"Main bus","language":"en"}';
      return '# Ignored title\n\nA main bus carries the basic resources [1].\n\n## Open questions\n\nRatios may have changed.';
    });

    const started = await api.call<Job>('POST', '/api/ai/research', { question: 'How to build a main bus?', depth: 'deep', mode: 'offline', notebookId: nb.id });
    const job = await finished<ResearchResult>(api, started.body.id);
    expect(job.error).toBeNull();
    expect(job.result).toMatchObject({ title: 'Main bus', sources: 0, searchProvider: 'offline' });
    server.off('request', onRequest);
    expect(searched).toBe(false);
    expect(calls).toHaveLength(2);
    expect(JSON.stringify(calls[1])).toContain('cannot search the web');
    // Deep offline notes may think longer; there are no sources to read.
    expect(calls[1]).toMatchObject({ reasoning: { effort: 'high' }, max_tokens: 14000 });
    expect(calls[1]).not.toHaveProperty('plugins');

    const page = (await api.call<Page>('GET', `/api/pages/${job.result!.pageId}`)).body;
    expect(page.tags).toEqual(['research']);
    expect(page.content).toContain('> **Research question:** How to build a main bus?');
    // Without sources, citation-like markers stay plain text and no sources list is added.
    expect(page.content).toContain('basic resources [1].');
    expect(page.content).not.toContain('## Sources');
    expect(page.content).not.toContain('Ignored title');
    expect(page.content).toMatch(/Written \d{4}-\d\d-\d\d from the model’s own knowledge, without web search · /);
  });

  it('can be cancelled', async () => {
    const api = setup({ importAllowPrivate: true, settingsEnv: { openrouterApiKey: 'sk-test', searxngUrl: base } as never });
    await api.call('POST', '/api/auth/setup', { username: 'nico', password: 'secret-pass' });
    const nb = (await api.call<Notebook>('POST', '/api/notebooks', { title: 'Games' })).body;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const realFetch = globalThis.fetch;
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      if (!String(input).startsWith('https://openrouter.ai/')) return realFetch(input, init);
      await gate;
      init?.signal?.throwIfAborted();
      return new Response(JSON.stringify({ choices: [{ message: { content: '{}' } }] }));
    });
    const started = await api.call<Job>('POST', '/api/ai/research', { question: 'Anything at all?', notebookId: nb.id });
    await new Promise((r) => setTimeout(r, 50));
    await api.call('POST', `/api/jobs/${started.body.id}/cancel`);
    release();
    expect(await finished(api, started.body.id)).toMatchObject({ status: 'cancelled' });
  });
});
