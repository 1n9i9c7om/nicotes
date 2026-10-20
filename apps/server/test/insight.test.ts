import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type AiLinkSuggestions,
  type AskEvent,
  MATCH_END,
  MATCH_START,
  type MentionsResult,
  type Notebook,
  type Page,
  type PageSummaryInfo,
  type PageTask,
  type SemanticHit,
  type SemanticResults,
  type SemanticStatus,
  type Settings,
} from '@nicotes/shared';
import { setup } from './helpers.js';

describe('unlinked mentions', () => {
  let api: ReturnType<typeof setup>;
  let notes: Notebook;

  beforeEach(async () => {
    api = setup();
    await api.call('POST', '/api/auth/setup', { username: 'nico', password: 'secret-pass' });
    notes = (await api.call<Notebook>('POST', '/api/notebooks', { title: 'Notes' })).body;
  });

  const create = async (title: string, content = '', parentId: string | null = null, notebookId = notes.id) =>
    (await api.call<Page>('POST', '/api/pages', { notebookId, parentId, title, content })).body;
  const get = async (id: string) => (await api.call<Page>('GET', `/api/pages/${id}`)).body;
  const mentions = async (id: string) => (await api.call<MentionsResult>('GET', `/api/pages/${id}/mentions`)).body;

  it('lists pages that name a page without linking it, and pages it names', async () => {
    const sourdough = await create('Sourdough starter', 'Feed it daily.');
    const bread = await create('Bread', 'Uses my sourdough starter.\nAgain: Sourdough starter rules.');
    await create('Linked', 'See [[Sourdough starter]] and sourdough starter.');
    await create('Code', '`sourdough starter` in code');
    const template = await create('Template', 'sourdough starter');
    await api.call('PUT', `/api/pages/${template.id}/tags`, { tags: ['template'] });

    const result = await mentions(sourdough.id);
    expect(result.incoming).toEqual([
      {
        id: bread.id,
        notebookId: notes.id,
        title: 'Bread',
        count: 2,
        excerpt: `Uses my ${MATCH_START}sourdough starter${MATCH_END}.`,
      },
    ]);
    expect((await mentions(bread.id)).outgoing).toEqual([
      expect.objectContaining({ id: sourdough.id, target: 'Sourdough starter', text: 'sourdough starter', count: 2 }),
    ]);
  });

  it('skips empty pages as link targets and qualifies ambiguous titles', async () => {
    const a = await create('Recipes', 'A');
    const other = (await api.call<Notebook>('POST', '/api/notebooks', { title: 'Other' })).body;
    const b = await create('Garden', 'B', null, other.id);
    const tips = await create('Tips', 'Some tips', b.id, other.id);
    await create('Tips', 'Other tips', a.id);
    await create('Empty one', '');
    const page = await create('Hub', 'Tips for the Garden. Also the Empty one.', null, other.id);

    const out = (await mentions(page.id)).outgoing;
    expect(out.map((m) => [m.title, m.target])).toEqual([
      ['Garden', 'Garden'],
      ['Tips', 'Tips'],
    ]);
    expect(out[1]!.id).toBe(tips.id); // the one in the same notebook, as a bare link resolves
  });

  it('links the first mention in source pages and keeps the old text as a version', async () => {
    const starter = await create('Sourdough starter', 'Feed it.');
    const bread = await create('Bread', 'My sourdough starter, again sourdough starter.');
    const res = await api.call<{ relinked: string[] }>('POST', `/api/pages/${starter.id}/mentions/link`, {
      sourceIds: [bread.id],
    });
    expect(res.body.relinked).toEqual([bread.id]);
    const updated = await get(bread.id);
    expect(updated.content).toBe('My [[sourdough starter]], again sourdough starter.');
    expect(updated.version).toBe(2);
    expect((await mentions(starter.id)).incoming).toEqual([]); // now a backlink instead
    const backlinks = (await api.call<{ id: string }[]>('GET', `/api/pages/${starter.id}/backlinks`)).body;
    expect(backlinks.map((b) => b.id)).toEqual([bread.id]);
    const versions = (await api.call<{ reason: string }[]>('GET', `/api/pages/${bread.id}/versions`)).body;
    expect(versions.map((v) => v.reason)).toEqual(['relink']);
  });
});

describe('tasks', () => {
  let api: ReturnType<typeof setup>;
  let notes: Notebook;

  beforeEach(async () => {
    api = setup();
    await api.call('POST', '/api/auth/setup', { username: 'nico', password: 'secret-pass' });
    notes = (await api.call<Notebook>('POST', '/api/notebooks', { title: 'Notes' })).body;
  });

  const create = async (title: string, content = '') =>
    (await api.call<Page>('POST', '/api/pages', { notebookId: notes.id, title, content })).body;
  const tasks = async (status = 'open') => (await api.call<PageTask[]>('GET', `/api/tasks?status=${status}`)).body;

  it('collects tasks across pages, sorted by due date, skipping templates', async () => {
    const shop = await create('Shopping', '- [ ] Flour 📅 2026-10-25\n- [x] Eggs\n- [ ] Milk');
    await create('Trip', '## Packing\n- [ ] Passport 📅 2026-10-21');
    const template = await create('Daily', '- [ ] Template task');
    await api.call('PUT', `/api/pages/${template.id}/tags`, { tags: ['template'] });

    expect((await tasks()).map((t) => [t.text, t.due, t.heading])).toEqual([
      ['Passport', '2026-10-21', 'Packing'],
      ['Flour', '2026-10-25', null],
      ['Milk', null, null],
    ]);
    expect((await tasks('done')).map((t) => [t.text, t.pageId])).toEqual([['Eggs', shop.id]]);
    expect(await tasks('all')).toHaveLength(4);
  });

  it('leaves out checklists of pages with excluded tags, recipes by default', async () => {
    const recipe = await create('Cookies', '## Ingredients\n- [ ] Butter');
    await api.call('PUT', `/api/pages/${recipe.id}/tags`, { tags: ['recipe'] });
    await create('Todo', '- [ ] Bake');
    expect((await tasks()).map((t) => t.text)).toEqual(['Bake']);

    await api.call('PATCH', '/api/settings', { tasksExcludeTags: [] });
    expect((await tasks()).map((t) => t.text).sort()).toEqual(['Bake', 'Butter']);
    await api.call('PATCH', '/api/settings', { tasksExcludeTags: null });
    expect((await tasks()).map((t) => t.text)).toEqual(['Bake']);
  });

  it('ticks off a task and sets its due date by rewriting its line', async () => {
    const shop = await create('Shopping', 'Intro\n- [ ] Flour\n- [ ] Milk');
    const [flour] = await tasks();
    const res = await api.call<Page>('PATCH', '/api/tasks', { pageId: shop.id, line: flour!.line, raw: flour!.raw, done: true, due: '2026-11-01' });
    expect(res.status).toBe(200);
    expect(res.body.content).toBe('Intro\n- [x] Flour 📅 2026-11-01\n- [ ] Milk');
    expect(res.body.version).toBe(2);

    // A stale line (the page changed since the list was loaded) is refused.
    const stale = await api.call('PATCH', '/api/tasks', { pageId: shop.id, line: 1, raw: '- [ ] Flour', done: true });
    expect(stale.status).toBe(409);
  });

  it('adds a task to a page', async () => {
    const day = await create('2026-10-20', '## Notes\n\n\n## Tasks\n\n- [ ] ');
    const res = await api.call<Page>('POST', '/api/tasks', { pageId: day.id, text: 'Call the bakery', due: '2026-10-22' });
    expect(res.status).toBe(201);
    expect(res.body.content).toBe('## Notes\n\n\n## Tasks\n\n- [ ] Call the bakery 📅 2026-10-22');
    expect((await tasks()).map((t) => t.text)).toEqual(['Call the bakery']);
  });
});

/** Deterministic stand-in for OpenRouter embeddings: hashed bag of words, so shared words mean similarity. */
function fakeEmbeddings() {
  const realFetch = globalThis.fetch;
  const inputs: string[] = [];
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith('https://openrouter.ai/api/v1/embeddings')) return realFetch(input, init);
    const body = JSON.parse(String(init?.body)) as { input: string[] };
    inputs.push(...body.input);
    const bag = (text: string) => {
      const v = new Array<number>(64).fill(0);
      for (const w of text.toLowerCase().match(/[a-z]{3,}/g) ?? []) {
        let h = 7;
        for (const ch of w) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
        v[h % 64]! += 1;
      }
      return v;
    };
    const data = body.input.map((text, index) => ({ index, embedding: bag(text) }));
    return new Response(JSON.stringify({ data, usage: { prompt_tokens: 10, cost: 0.000001 * body.input.length } }), { status: 200 });
  });
  return inputs;
}

describe('semantic index', () => {
  let api: ReturnType<typeof setup>;
  let notes: Notebook;

  beforeEach(async () => {
    api = setup({ settingsEnv: { openrouterApiKey: 'sk-test' } as never, semanticQuietMs: 0 });
    await api.call('POST', '/api/auth/setup', { username: 'nico', password: 'secret-pass' });
    notes = (await api.call<Notebook>('POST', '/api/notebooks', { title: 'Notes' })).body;
  });
  afterEach(() => vi.unstubAllGlobals());

  const create = async (title: string, content = '') =>
    (await api.call<Page>('POST', '/api/pages', { notebookId: notes.id, title, content })).body;
  const status = async () => (await api.call<SemanticStatus>('GET', '/api/semantic/status')).body;
  const search = async (q: string) =>
    (await api.call<SemanticResults<SemanticHit>>('GET', `/api/semantic/search?q=${encodeURIComponent(q)}`)).body;
  const related = async (id: string) =>
    (await api.call<SemanticResults<SemanticHit>>('GET', `/api/semantic/related/${id}`)).body;

  it('stays off until enabled, then indexes pages and finds them by meaning', async () => {
    const inputs = fakeEmbeddings();
    const bread = await create('Bread', 'Sourdough bread needs a sourdough starter, flour, water and salt.\n\nBake the bread hot.');
    await create('Factory', '## Logistics\n\nTrains and belts move ore to the smelters.');
    expect(await search('sourdough flour')).toEqual({ enabled: false, results: [] });
    await api.semantic.run();
    expect(inputs).toEqual([]); // nothing is sent while it is off

    await api.call('PATCH', '/api/settings', { semanticIndex: true });
    await api.semantic.run();
    expect(await status()).toMatchObject({ enabled: true, pages: 2, indexed: 2, chunks: 2, error: null });
    expect((await status()).cost).toBeGreaterThan(0);
    expect(inputs).toContain('Factory › Logistics\n\nTrains and belts move ore to the smelters.');

    const found = await search('sourdough flour water');
    expect(found.results[0]).toMatchObject({ id: bread.id, title: 'Bread' });
    expect(found.results[0]!.excerpt).toContain('Sourdough bread');
  });

  it('re-embeds only changed passages and clears everything when switched off', async () => {
    const inputs = fakeEmbeddings();
    await api.call('PATCH', '/api/settings', { semanticIndex: true });
    const page = await create('Bread', 'First paragraph about flour.\n\n## Baking\n\nBake it hot.');
    await api.semantic.run();
    expect(inputs).toHaveLength(2);

    await api.call('PATCH', `/api/pages/${page.id}`, { content: 'First paragraph about flour.\n\n## Baking\n\nBake it very hot.', baseVersion: 1 });
    await api.semantic.run();
    expect(inputs).toHaveLength(3);
    expect(inputs.at(-1)).toBe('Bread › Baking\n\nBake it very hot.');

    await api.call('PATCH', '/api/settings', { semanticIndex: false });
    expect(await status()).toMatchObject({ enabled: false, indexed: 0, chunks: 0 });
  });

  it('suggests related pages that are not yet connected', async () => {
    fakeEmbeddings();
    await api.call('PATCH', '/api/settings', { semanticIndex: true });
    const bread = await create('Bread', 'Sourdough bread with a sourdough starter, flour and water.');
    const starter = await create('Starter', 'Feed the sourdough starter with flour and water every day.');
    await create('Factory', 'Trains and belts move ore to the smelters.');
    await api.semantic.run();
    expect((await related(bread.id)).results.map((r) => r.id)).toEqual([starter.id]);

    await api.call('PATCH', `/api/pages/${bread.id}`, { content: 'Sourdough bread with a [[Starter]], flour and water.', baseVersion: 1 });
    await api.semantic.run();
    expect((await related(bread.id)).results).toEqual([]); // linked now
  });

  it('records embedding errors and retries later', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ error: { message: 'No credits' } }), { status: 402 }));
    await api.call('PATCH', '/api/settings', { semanticIndex: true });
    await create('Bread', 'Flour and water.');
    await api.semantic.run();
    expect(await status()).toMatchObject({ indexed: 0, error: 'Your OpenRouter credits are used up' });
  });
});

describe('ask your notes', () => {
  /** Fake OpenRouter: embeddings as above, chat completions streamed as server-sent events. */
  function fakeOpenRouter(answer: string[]) {
    const prompts: string[] = [];
    fakeEmbeddings();
    const embeddings = globalThis.fetch;
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (!url.endsWith('/chat/completions')) return embeddings(input, init);
      const body = JSON.parse(String(init?.body)) as { stream: boolean; messages: { content: string }[] };
      expect(body.stream).toBe(true);
      prompts.push(body.messages.map((m) => m.content).join('\n'));
      const encoder = new TextEncoder();
      const event = (data: unknown) => encoder.encode(`data: ${JSON.stringify(data)}\n\n`);
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode(': OPENROUTER PROCESSING\n\n'));
            for (const text of answer) controller.enqueue(event({ choices: [{ delta: { content: text } }] }));
            controller.enqueue(event({ choices: [{ delta: {} }], usage: { prompt_tokens: 200, completion_tokens: 30, cost: 0.0004 } }));
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            controller.close();
          },
        }),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      );
    });
    return prompts;
  }

  let api: ReturnType<typeof setup>;
  let notes: Notebook;
  beforeEach(async () => {
    api = setup({ settingsEnv: { openrouterApiKey: 'sk-test' } as never, semanticQuietMs: 0 });
    await api.call('POST', '/api/auth/setup', { username: 'nico', password: 'secret-pass' });
    notes = (await api.call<Notebook>('POST', '/api/notebooks', { title: 'Notes' })).body;
  });
  afterEach(() => vi.unstubAllGlobals());

  const create = async (title: string, content = '') =>
    (await api.call<Page>('POST', '/api/pages', { notebookId: notes.id, title, content })).body;
  const ask = async (question: string, history: { question: string; answer: string }[] = []) => {
    const res = await api.rawPost('/api/ai/ask', { question, history });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    return (await res.text())
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => JSON.parse(l.slice(5)) as AskEvent);
  };

  it('answers from passages found by meaning, streaming the text', async () => {
    const prompts = fakeOpenRouter(['Feed it ', 'daily [1].']);
    await api.call('PATCH', '/api/settings', { semanticIndex: true });
    const starter = await create('Starter', 'Feed the sourdough starter with flour and water every day.');
    await create('Factory', 'Trains and belts move ore to the smelters.');
    await api.semantic.run();

    const events = await ask('How often do I feed the sourdough starter?');
    const sources = events.find((e) => e.type === 'sources');
    expect(sources).toMatchObject({ retrieval: 'semantic', sources: [{ n: 1, pageId: starter.id, title: 'Starter' }] });
    expect(events.filter((e) => e.type === 'delta').map((e) => (e as { text: string }).text).join('')).toBe('Feed it daily [1].');
    expect(events.at(-1)).toEqual({ type: 'done', cost: 0.0004, model: expect.any(String) });
    expect(prompts[0]).toContain('[1] Starter\nFeed the sourdough starter');
    expect(prompts[0]).toContain('Answer in English.');
  });

  it('falls back to keyword search and passes the conversation along', async () => {
    const prompts = fakeOpenRouter(['Weekly.']);
    const starter = await create('Starter', '## Care\n\nFeed the sourdough starter with flour and water every day.');
    const events = await ask('Wie oft füttere ich den Sourdough Starter?', [{ question: 'What is a starter?', answer: 'A culture [1].' }]);
    expect(events[0]).toMatchObject({ type: 'sources', retrieval: 'keyword', sources: [{ pageId: starter.id, heading: 'Care' }] });
    expect(prompts[0]).toContain('What is a starter?\nA culture [1].');
    expect(prompts[0]).toContain('Answer in German.');
  });

  it('refuses without an API key', async () => {
    const plain = setup();
    await plain.call('POST', '/api/auth/setup', { username: 'nico', password: 'secret-pass' });
    const res = await plain.rawPost('/api/ai/ask', { question: 'Anything?' });
    expect(res.status).toBe(400);
  });
});

describe('summaries and AI link suggestions', () => {
  /** Fake chat completions (non-streaming); `reply` answers per prompt. */
  function fakeChat(reply: (prompt: string) => string, cost = 0.0002) {
    const prompts: string[] = [];
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (!url.endsWith('/chat/completions')) throw new Error(`unexpected request to ${url}`);
      const body = JSON.parse(String(init?.body)) as { messages: { content: string }[] };
      const prompt = body.messages.map((m) => m.content).join('\n');
      prompts.push(prompt);
      return new Response(JSON.stringify({ choices: [{ message: { content: reply(prompt) } }], usage: { cost } }), { status: 200 });
    });
    return prompts;
  }

  let api: ReturnType<typeof setup>;
  let notes: Notebook;
  beforeEach(async () => {
    api = setup({ settingsEnv: { openrouterApiKey: 'sk-test' } as never });
    await api.call('POST', '/api/auth/setup', { username: 'nico', password: 'secret-pass' });
    notes = (await api.call<Notebook>('POST', '/api/notebooks', { title: 'Notes' })).body;
  });
  afterEach(() => vi.unstubAllGlobals());

  const create = async (title: string, content = '') =>
    (await api.call<Page>('POST', '/api/pages', { notebookId: notes.id, title, content })).body;
  const long = 'Sourdough needs a lively starter. '.repeat(5);

  it('summarizes a page and notices when the page changed since', async () => {
    const prompts = fakeChat(() => '"A note about sourdough starters."');
    const page = await create('Sourdough', long);
    expect((await api.call('GET', `/api/ai/summary/${page.id}`)).body).toBeNull();

    const made = await api.call<PageSummaryInfo>('POST', `/api/ai/summary/${page.id}`);
    expect(made.body).toMatchObject({ summary: 'A note about sourdough starters.', stale: false, cost: 0.0002 });
    expect(prompts[0]).toContain('Write in English.');

    await api.call('PATCH', `/api/pages/${page.id}`, { content: `${long} More.`, baseVersion: 1 });
    expect((await api.call<PageSummaryInfo>('GET', `/api/ai/summary/${page.id}`)).body.stale).toBe(true);
    expect((await api.call('DELETE', `/api/ai/summary/${page.id}`)).status).toBe(204);
    expect((await api.call('GET', `/api/ai/summary/${page.id}`)).body).toBeNull();

    const short = await create('Short', 'Too short.');
    expect((await api.call('POST', `/api/ai/summary/${short.id}`)).status).toBe(400);
  });

  it('suggests links whose phrase really is in the text, to unlinked pages only', async () => {
    const starter = await create('Starter', 'Feed it daily.');
    const flour = await create('Flour types', 'Rye, wheat, spelt.');
    await create('Linked already', 'x');
    const page = await create('Bread', 'My levain gets rye flour every morning. See [[Linked already]].');
    fakeChat((prompt) => {
      expect(prompt).not.toContain('Linked already |');
      const id = (title: string) => new RegExp(`(c\\d+) \\| Notes / ${title} \\|`).exec(prompt)![1];
      return JSON.stringify({
        links: [
          { phrase: 'levain', page: id('Starter'), reason: 'Levain is a starter.' },
          { phrase: 'RYE FLOUR', page: id('Flour types'), reason: 'Flour details.' },
          { phrase: 'not in the text', page: id('Starter'), reason: 'invented' },
          { phrase: 'morning', page: 'c999', reason: 'unknown page' },
        ],
      });
    });
    const res = await api.call<AiLinkSuggestions>('POST', `/api/ai/link-suggestions/${page.id}`);
    expect(res.status).toBe(200);
    expect(res.body.suggestions).toEqual([
      { phrase: 'levain', pageId: starter.id, title: 'Starter', target: 'Starter', reason: 'Levain is a starter.' },
      { phrase: 'rye flour', pageId: flour.id, title: 'Flour types', target: 'Flour types', reason: 'Flour details.' },
    ]);
  });
});

describe('models per AI feature', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('uses the feature model where set and the default model elsewhere', async () => {
    const api = setup({ settingsEnv: { openrouterApiKey: 'sk-test', researchModel: 'env/research' } as never });
    await api.call('POST', '/api/auth/setup', { username: 'nico', password: 'secret-pass' });
    const notes = (await api.call<Notebook>('POST', '/api/notebooks', { title: 'Notes' })).body;
    const page = (
      await api.call<Page>('POST', '/api/pages', { notebookId: notes.id, title: 'Bread', content: 'Sourdough needs a lively starter. '.repeat(5) })
    ).body;

    const settings = (await api.call<Settings>('PATCH', '/api/settings', { summaryModel: 'vendor/strong', askModel: 'vendor/ask' })).body;
    expect(settings.models).toMatchObject({
      summary: { model: 'vendor/strong', source: 'settings' },
      ask: { model: 'vendor/ask', source: 'settings' },
      research: { model: 'env/research', source: 'env' },
      import: { model: null, source: null },
    });

    const models: string[] = [];
    vi.stubGlobal('fetch', async (_input: string | URL | Request, init?: RequestInit) => {
      models.push((JSON.parse(String(init?.body)) as { model: string }).model);
      return new Response(JSON.stringify({ choices: [{ message: { content: 'A summary.' } }], usage: { cost: 0 } }), { status: 200 });
    });
    await api.call('POST', `/api/ai/summary/${page.id}`);
    await api.call('PATCH', '/api/settings', { summaryModel: null });
    await api.call('POST', `/api/ai/summary/${page.id}`);
    expect(models).toEqual(['vendor/strong', 'z-ai/glm-5.3-flashx']);
  });
});
