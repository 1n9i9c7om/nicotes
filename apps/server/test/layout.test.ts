import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Notebook, Page, PageLayoutInfo } from '@nicotes/shared';
import { setup } from './helpers.js';

describe('page layouts', () => {
  let api: ReturnType<typeof setup>;
  let notes: Notebook;
  const prompts: string[] = [];

  beforeEach(async () => {
    api = setup({ settingsEnv: { openrouterApiKey: 'sk-test' } as never });
    await api.call('POST', '/api/auth/setup', { username: 'nico', password: 'secret-pass' });
    notes = (await api.call<Notebook>('POST', '/api/notebooks', { title: 'Notes' })).body;
    prompts.length = 0;
  });
  afterEach(() => vi.unstubAllGlobals());

  /** Fake OpenRouter answering with `reply(prompt)`. */
  const fake = (reply: (prompt: string) => object) =>
    vi.stubGlobal('fetch', async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { messages: { content: string }[] };
      const prompt = body.messages.map((m) => m.content).join('\n');
      prompts.push(prompt);
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(reply(prompt)) } }], usage: { cost: 0.0003 } }), {
        status: 200,
      });
    });

  const create = async (title: string, content: string) =>
    (await api.call<Page>('POST', '/api/pages', { notebookId: notes.id, title, content })).body;
  const layout = async (id: string) => (await api.call<PageLayoutInfo | null>('GET', `/api/ai/layout/${id}`)).body;

  const recipe = 'Für 4 Personen.\n\nTeig:\n- 200 g Mehl\n- 100 g Butter\n\nDen Ofen vorheizen.\n\nAlles verkneten und 30 Minuten backen.';

  it('lets the AI choose a layout and maps its block ids to stable keys', async () => {
    fake(() => ({ type: 'recipe', language: 'de', servings: 4, ingredients: ['b3'], steps: ['b4', 'b5', 'b99'], lists: ['b3'], reason: 'Ein Rezept.' }));
    const page = await create('Kuchen', recipe);
    expect(await layout(page.id)).toBeNull();

    const res = await api.call<PageLayoutInfo>('POST', `/api/ai/layout/${page.id}`, {});
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      source: 'ai',
      stale: false,
      reason: 'Ein Rezept.',
      cost: 0.0003,
      spec: { type: 'recipe', language: 'de', servings: 4, ingredients: ['list::0'], steps: ['paragraph::2', 'paragraph::3'], lists: [] },
    });
    expect(prompts[0]).toContain('b3 | bullet list, 2 items | — | 200 g Mehl; 100 g Butter');

    await api.call('PATCH', `/api/pages/${page.id}`, { content: `${recipe}\n\nGuten Appetit!`, baseVersion: 1 });
    expect((await layout(page.id))!.stale).toBe(true);
  });

  it('offers tables and nested lists to the AI and accepts them', async () => {
    const content = [
      '## Recipe', // b1
      '| Ingredient | Amount |', // b2
      '| --- | --- |',
      '| Butter | 115 g [1](https://a.example/1) |',
      '',
      '- **Pan:** 20 cm', // b3, item 1
      '- **Method:**', // item 2
      '  1. Melt the butter', // b3.2
      '  2. Bake',
    ].join('\n');
    fake(() => ({ type: 'recipe', ingredients: ['b2', 'b3'], steps: ['b3.2', 'b3.9'], reason: 'A recipe.' }));
    const page = await create('Cake', content);
    const res = await api.call<PageLayoutInfo>('POST', `/api/ai/layout/${page.id}`, {});
    expect(res.body.spec).toMatchObject({ ingredients: ['table:Recipe:0', 'list:Recipe:0'], steps: ['list:Recipe:0>1'] });
    expect(prompts[0]).toContain('b2 | table, 1 rows | Recipe | columns: Ingredient / Amount; Butter / 115 g');
    expect(prompts[0]).toContain('b3.2 | numbered list, 2 items nested under item 2 "Method" | Recipe | Melt the butter; Bake');
  });

  it('fills parts the AI left out from the heuristic, and keeps a forced type', async () => {
    fake(() => ({ type: 'document', reason: 'Unsure.' }));
    const page = await create('List', '## Packing\n- Socks\n- Jacket');
    const res = await api.call<PageLayoutInfo>('POST', `/api/ai/layout/${page.id}`, { type: 'checklist' });
    expect(res.body.spec).toMatchObject({ type: 'checklist', lists: ['list:Packing:0'] });
    expect(prompts[0]).toContain('The user chose the layout "checklist"');
  });

  it('stores a hand-picked layout without AI and can go back to automatic', async () => {
    const page = await create('Guide', '1. Unplug\n2. Open\n3. Swap');
    const res = await api.call<PageLayoutInfo>('PUT', `/api/ai/layout/${page.id}`, { type: 'steps' });
    expect(res.body).toMatchObject({ source: 'manual', spec: { type: 'steps', steps: ['list::0'] } });
    expect((await api.call('DELETE', `/api/ai/layout/${page.id}`)).status).toBe(204);
    expect(await layout(page.id)).toBeNull();
  });

  it('needs an API key for the AI', async () => {
    const plain = setup();
    await plain.call('POST', '/api/auth/setup', { username: 'nico', password: 'secret-pass' });
    const nb = (await plain.call<Notebook>('POST', '/api/notebooks', { title: 'N' })).body;
    const page = (await plain.call<Page>('POST', '/api/pages', { notebookId: nb.id, title: 'P', content: 'x' })).body;
    expect((await plain.call('POST', `/api/ai/layout/${page.id}`, {})).status).toBe(400);
  });
});
