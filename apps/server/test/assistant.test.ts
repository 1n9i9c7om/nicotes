import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssistantEvent, Notebook, Page, PageVersionSummary } from '@nicotes/shared';
import { PAGE_END, PAGE_START, ReplySplitter, tidyProposal } from '../src/ai/assistant.js';
import { retrieve } from '../src/ai/retrieve.js';
import { notebookPageIds } from '../src/ai/scope.js';
import { users } from '../src/db/schema.js';
import { setup } from './helpers.js';

/** Fake OpenRouter chat completions, streamed as server-sent events in the given pieces. */
function fakeStream(pieces: string[]) {
  const prompts: string[] = [];
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.endsWith('/chat/completions')) throw new Error(`unexpected request to ${url}`);
    const body = JSON.parse(String(init?.body)) as { messages: { content: string }[] };
    prompts.push(body.messages.map((m) => m.content).join('\n'));
    const encoder = new TextEncoder();
    const event = (data: unknown) => encoder.encode(`data: ${JSON.stringify(data)}\n\n`);
    return new Response(
      new ReadableStream({
        start(controller) {
          for (const text of pieces) controller.enqueue(event({ choices: [{ delta: { content: text } }] }));
          controller.enqueue(event({ choices: [{ delta: {} }], usage: { cost: 0.001 } }));
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        },
      }),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    );
  });
  return prompts;
}

describe('ReplySplitter', () => {
  it('passes the message on and keeps the page, even with markers split across pieces', () => {
    const splitter = new ReplySplitter();
    const reply = `Added a step.\n${PAGE_START}\n- one\n- two\n${PAGE_END}\n`;
    let shown = '';
    for (let i = 0; i < reply.length; i += 3) shown += splitter.feed(reply.slice(i, i + 3));
    const { rest, page } = splitter.finish();
    expect(shown + rest).toBe('Added a step.\n');
    expect(page).toBe('- one\n- two\n');
  });

  it('handles replies without a page, a missing end marker and code fences', () => {
    const plain = new ReplySplitter();
    expect(plain.feed('Just an answer <<<') + plain.finish().rest).toBe('Just an answer <<<');

    const fenced = new ReplySplitter();
    fenced.feed(`Done.\n${PAGE_START}\n\`\`\`markdown\nText\n\`\`\``);
    expect(fenced.finish().page).toBe('Text');
  });

  it('drops a repeated title and keeps the original trailing newline', () => {
    expect(tidyProposal('# Shopping\n\n- milk\n\n', 'Shopping', '- bread\n')).toBe('- milk\n');
    expect(tidyProposal('# Other\n- milk', 'Shopping', '- bread')).toBe('# Other\n- milk');
  });
});

describe('page assistant', () => {
  let api: ReturnType<typeof setup>;
  let games: Notebook;
  let other: Notebook;
  beforeEach(async () => {
    api = setup({ settingsEnv: { openrouterApiKey: 'sk-test' } as never });
    await api.call('POST', '/api/auth/setup', { username: 'nico', password: 'secret-pass' });
    games = (await api.call<Notebook>('POST', '/api/notebooks', { title: 'Games' })).body;
    other = (await api.call<Notebook>('POST', '/api/notebooks', { title: 'Other' })).body;
  });
  afterEach(() => vi.unstubAllGlobals());

  const create = async (title: string, content: string, parentId: string | null = null, notebookId = games.id) =>
    (await api.call<Page>('POST', '/api/pages', { notebookId, parentId, title, content })).body;
  const assist = async (pageId: string, body: object) => {
    const res = await api.rawPost(`/api/ai/pages/${pageId}/assistant`, body);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    return (await res.text())
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => JSON.parse(l.slice(5)) as AssistantEvent);
  };

  it('streams the message and proposes the whole page separately', async () => {
    const page = await create('Shopping', '- bread\n- milk');
    const prompts = fakeStream(['Added eggs.', `\n${PAGE_START}\n- bread\n- milk\n`, `- eggs\n${PAGE_END}`]);
    const events = await assist(page.id, { message: 'Add eggs', title: 'Shopping', content: '- bread\n- milk (unsaved)' });

    expect(events.filter((e) => e.type === 'delta').map((e) => (e as { text: string }).text).join('')).toBe('Added eggs.\n');
    expect(events.find((e) => e.type === 'proposal')).toEqual({ type: 'proposal', content: '- bread\n- milk\n- eggs' });
    expect(events.at(-1)).toEqual({ type: 'done', cost: 0.001, model: expect.any(String) });
    // The text the user sees is sent, not the saved one; no other notes in "this page only".
    expect(prompts[0]).toContain('- milk (unsaved)');
    expect(prompts[0]).not.toContain('OTHER NOTES');
    // The assistant never writes: the page is unchanged until the user applies changes.
    expect((await api.call<Page>('GET', `/api/pages/${page.id}`)).body.content).toBe('- bread\n- milk');
  });

  it('sends no proposal for a plain answer or an unchanged page', async () => {
    const page = await create('Shopping', '- bread');
    fakeStream(['Two items.']);
    expect((await assist(page.id, { message: 'How many?', content: '- bread' })).some((e) => e.type === 'proposal')).toBe(false);
    fakeStream([`Nothing to do.\n${PAGE_START}\n- bread\n${PAGE_END}`]);
    expect((await assist(page.id, { message: 'Fix typos', content: '- bread' })).some((e) => e.type === 'proposal')).toBe(false);
  });

  it('reads other notes only within the chosen scope', async () => {
    const elden = await create('Elden Ring', 'Boss notes for the dragon');
    const builds = await create('Builds', 'Dragon slaying build', elden.id);
    const page = await create('Strength', 'Dragon fight plan', builds.id);
    const sibling = await create('Malenia', 'Dragon free boss', elden.id);
    const outside = await create('Factorio', 'Dragon trains');
    const elsewhere = await create('Diary', 'Dragon dream', null, other.id);

    const read = async (scope: string) => {
      fakeStream(['Ok.']);
      const events = await assist(page.id, { message: 'What about the dragon?', title: 'Strength', content: 'Dragon fight plan', scope });
      const context = events.find((e) => e.type === 'context') as Extract<AssistantEvent, { type: 'context' }>;
      return context.notes.map((n) => n.pageId).sort();
    };
    expect(await read('page')).toEqual([]);
    // Section: the parent ("Builds") and everything under it, but not the page itself.
    expect(await read('section')).toEqual([builds.id].sort());
    expect(await read('notebook')).toEqual([elden.id, builds.id, sibling.id, outside.id].sort());
    expect(await read('all')).toEqual([elden.id, builds.id, sibling.id, outside.id, elsewhere.id].sort());
  });

  it('refuses without an API key and for other users’ pages', async () => {
    const page = await create('Shopping', '- bread');
    const plain = setup();
    await plain.call('POST', '/api/auth/setup', { username: 'nico', password: 'secret-pass' });
    expect((await plain.rawPost(`/api/ai/pages/${page.id}/assistant`, { message: 'Hi', content: '' })).status).toBe(404);
  });
});

describe('applying reviewed changes', () => {
  let api: ReturnType<typeof setup>;
  let page: Page;
  beforeEach(async () => {
    api = setup();
    await api.call('POST', '/api/auth/setup', { username: 'nico', password: 'secret-pass' });
    const nb = (await api.call<Notebook>('POST', '/api/notebooks', { title: 'Notes' })).body;
    page = (await api.call<Page>('POST', '/api/pages', { notebookId: nb.id, title: 'List', content: '- bread' })).body;
  });

  it('keeps the state before as an "assistant" version', async () => {
    const res = await api.call<Page>('POST', `/api/pages/${page.id}/changes`, {
      content: '- bread\n- eggs',
      baseVersion: page.version,
      reason: 'assistant',
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ content: '- bread\n- eggs', version: page.version + 1 });
    const versions = (await api.call<PageVersionSummary[]>('GET', `/api/pages/${page.id}/versions`)).body;
    expect(versions[0]).toMatchObject({ reason: 'assistant', size: '- bread'.length });
  });

  it('rejects changes computed against an older version', async () => {
    await api.call('PATCH', `/api/pages/${page.id}`, { content: '- rye', baseVersion: page.version });
    const res = await api.call('POST', `/api/pages/${page.id}/changes`, { content: 'x', baseVersion: page.version, reason: 'restore' });
    expect(res.status).toBe(409);
  });
});

describe('read scopes', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('limits the notes searched to the chosen notebooks', async () => {
    const api = setup();
    await api.call('POST', '/api/auth/setup', { username: 'nico', password: 'secret-pass' });
    const userId = api.db.select({ id: users.id }).from(users).get()!.id;
    const a = (await api.call<Notebook>('POST', '/api/notebooks', { title: 'A' })).body;
    const b = (await api.call<Notebook>('POST', '/api/notebooks', { title: 'B' })).body;
    await api.call('POST', '/api/pages', { notebookId: a.id, title: 'Starter A', content: 'Feed the sourdough starter daily' });
    const inB = (await api.call<Page>('POST', '/api/pages', { notebookId: b.id, title: 'Starter B', content: 'Sourdough starter weekly' })).body;

    const find = async (notebookIds?: string[]) => {
      const allowed = notebookIds ? notebookPageIds(api.db, userId, notebookIds) : null;
      const found = await retrieve(api.db, api.semantic, userId, 'How often to feed the sourdough starter?', allowed);
      return found.passages.map((p) => p.pageId);
    };
    expect(await find()).toHaveLength(2);
    expect(await find([b.id])).toEqual([inB.id]);
    expect(await find([])).toEqual([]);
  });
});
