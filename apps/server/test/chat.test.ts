import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatEntry, ChatEvent, Notebook, Page, PageTask } from '@nicotes/shared';
import { setup } from './helpers.js';

interface Sent {
  messages: { role: string; content: string | null; tool_calls?: unknown[]; tool_call_id?: string }[];
  tools: { function: { name: string; parameters: { properties?: Record<string, unknown> } } }[];
  tool_choice: string;
}

type Reply = { content?: string; calls?: { name: string; args: unknown }[] };

/** A fake model: answers each request with the next scripted reply (tool calls or text). */
function fakeModel(replies: Reply[]) {
  const sent: Sent[] = [];
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.endsWith('/chat/completions')) throw new Error(`unexpected request to ${url}`);
    sent.push(JSON.parse(String(init?.body)) as Sent);
    const reply = replies.shift() ?? { content: 'No more replies scripted.' };
    const message = {
      content: reply.content ?? null,
      tool_calls: reply.calls?.map((c, i) => ({ id: `call_${sent.length}_${i}`, type: 'function', function: { name: c.name, arguments: typeof c.args === 'string' ? c.args : JSON.stringify(c.args) } })),
    };
    return Response.json({ choices: [{ message }], usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.0001 } });
  });
  return sent;
}

async function signedIn() {
  const api = setup();
  await api.call('POST', '/api/auth/setup', { username: 'nico', password: 'secret-pass' });
  await api.call('PATCH', '/api/settings', { openrouterApiKey: 'sk-or-test', reminderTimeZone: 'Europe/Berlin' });
  return api;
}

/** Sends a chat message and collects the server-sent events. */
async function chat(api: Awaited<ReturnType<typeof signedIn>>, text: string): Promise<ChatEvent[]> {
  const res = await api.rawPost('/api/chat', { text });
  const body = await res.text();
  return body
    .split('\n')
    .filter((l) => l.startsWith('data: '))
    .map((l) => JSON.parse(l.slice(6)) as ChatEvent);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.parse('2026-11-04T09:00:00Z')); // a Wednesday, 10:00 in Berlin
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('chat', () => {
  it('adds a task to today\'s journal through a tool call, then answers', async () => {
    const api = await signedIn();
    const sent = fakeModel([
      { calls: [{ name: 'add_task', args: { text: 'Buy milk', due: '2026-11-05', remind_at: '08:30' } }] },
      { content: 'Added **Buy milk** for tomorrow, with a reminder at 8:30.' },
    ]);
    const events = await chat(api, 'Remind me to buy milk tomorrow morning');
    expect(events.map((e) => e.type)).toEqual(['user', 'action', 'answer']);
    expect(events[1]).toEqual({ type: 'action', action: { tool: 'add_task', summary: 'Added the task “Buy milk” (due 2026-11-05)', pageId: expect.any(String), ok: true } });
    const answer = events[2] as Extract<ChatEvent, { type: 'answer' }>;
    expect(answer.entry.content).toBe('Added **Buy milk** for tomorrow, with a reminder at 8:30.');

    // The model was told the date, got the tools, and saw the tool's result.
    expect(sent[0]!.messages[0]!.content).toContain('Wednesday, 2026-11-04, 10:00 (Europe/Berlin)');
    expect(sent[0]!.tools.map((t) => t.function.name)).toEqual(expect.arrayContaining(['search_notes', 'add_task', 'calendar', 'start_research']));
    expect(sent[0]!.tools.find((t) => t.function.name === 'add_task')!.function.parameters.properties).toHaveProperty('due');
    expect(sent[1]!.messages.at(-1)).toEqual({ role: 'tool', tool_call_id: 'call_1_0', content: '{"ok":true}' });

    const tasks = (await api.call<PageTask[]>('GET', '/api/tasks')).body;
    expect(tasks).toEqual([expect.objectContaining({ text: 'Buy milk', due: '2026-11-05', remind: '2026-11-05T08:30', pageTitle: '2026-11-04' })]);
    const history = (await api.call<ChatEntry[]>('GET', '/api/chat')).body;
    expect(history.map((h) => [h.role, h.actions.length])).toEqual([
      ['user', 0],
      ['assistant', 1],
    ]);
  });

  it('looks things up across several rounds and remembers the conversation until reset', async () => {
    const api = await signedIn();
    const nb = (await api.call<Notebook>('POST', '/api/notebooks', { title: 'Home' })).body;
    await api.call<Page>('POST', '/api/pages', {
      notebookId: nb.id,
      title: 'Car',
      content: '- [ ] Book the service 📅 2026-11-06\n- [x] Buy tyres 📅 2026-11-03\n\nThe car is a blue Golf.',
    });
    const sent = fakeModel([
      { calls: [{ name: 'calendar', args: { from: '2026-11-04', to: '2026-11-10' } }, { name: 'search_notes', args: { query: 'car' } }] },
      { calls: [{ name: 'read_page', args: { page: 'Car' } }] },
      { content: 'Friday: book the car service ([[Car]]).' },
      { content: 'It is a blue Golf.' },
    ]);
    await chat(api, 'What is on this week?');
    const calendar = JSON.parse(sent[1]!.messages.find((m) => m.tool_call_id === 'call_1_0')!.content!) as { days: { date: string; weekday: string; tasks: { text: string; ref: string }[] }[] };
    expect(calendar.days).toEqual([{ date: '2026-11-06', weekday: 'Friday', journal: false, tasks: [expect.objectContaining({ text: 'Book the service', done: false })] }]);
    expect(sent[2]!.messages.at(-1)!.content).toContain('The car is a blue Golf.');

    // A follow-up: the earlier messages go along.
    await chat(api, 'Which car is it again?');
    expect(sent[3]!.messages.slice(1).map((m) => [m.role, m.content])).toEqual([
      ['user', 'What is on this week?'],
      ['assistant', 'Friday: book the car service ([[Car]]).'],
      ['user', 'Which car is it again?'],
    ]);

    expect((await api.call('DELETE', '/api/chat')).status).toBe(204);
    expect((await api.call<ChatEntry[]>('GET', '/api/chat')).body).toEqual([]);
    const fresh = fakeModel([{ content: 'Hello!' }]);
    await chat(api, 'Hi');
    expect(fresh[0]!.messages.map((m) => m.role)).toEqual(['system', 'user']);
  });

  it('ticks a task off by its ref, and reports tool mistakes back to the model', async () => {
    const api = await signedIn();
    const nb = (await api.call<Notebook>('POST', '/api/notebooks', { title: 'Home' })).body;
    const page = (await api.call<Page>('POST', '/api/pages', { notebookId: nb.id, title: 'Chores', content: '- [ ] Water the plants' })).body;
    const sent = fakeModel([
      { calls: [{ name: 'update_task', args: '{not json' }, { name: 'nope', args: {} }, { name: 'update_task', args: { ref: `${page.id}:0`, done: true } }] },
      { content: 'Done.' },
    ]);
    const events = await chat(api, 'I watered the plants');
    const actions = events.filter((e) => e.type === 'action').map((e) => (e as Extract<ChatEvent, { type: 'action' }>).action);
    expect(actions.map((a) => [a.ok, a.summary])).toEqual([
      [false, 'update task: The arguments were not valid JSON'],
      [false, 'Unknown tool nope'],
      [true, 'Ticked off “Water the plants”'],
    ]);
    expect(sent[1]!.messages.filter((m) => m.role === 'tool').map((m) => JSON.parse(m.content!))).toEqual([
      { error: 'The arguments were not valid JSON' },
      { error: 'Unknown tool nope' },
      { ok: true },
    ]);
    expect((await api.call<Page>('GET', `/api/pages/${page.id}`)).body.content).toBe('- [x] Water the plants');
  });

  it('stops calling tools after eight rounds and answers', async () => {
    const api = await signedIn();
    const sent = fakeModel([...Array.from({ length: 8 }, () => ({ calls: [{ name: 'list_notebooks', args: {} }] })), { content: 'Here is what I found.' }]);
    const events = await chat(api, 'Loop forever');
    expect(sent).toHaveLength(9);
    expect(sent.map((s) => s.tool_choice)).toEqual([...Array(8).fill('auto'), 'none']);
    expect((events.at(-1) as Extract<ChatEvent, { type: 'answer' }>).entry.content).toBe('Here is what I found.');
  });

  it('says what is missing without an AI key', async () => {
    const api = setup();
    await api.call('POST', '/api/auth/setup', { username: 'nico', password: 'secret-pass' });
    const events = await chat(api, 'Hello');
    expect(events).toEqual([{ type: 'error', error: 'The chat needs an OpenRouter API key — add one under Settings.' }]);
  });
});
