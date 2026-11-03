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
    expect(events[1]).toEqual({ type: 'action', action: { tool: 'add_task', summary: 'Added the task “Buy milk” (due 2026-11-05)', pageId: expect.any(String), ok: true, args: '{"text":"Buy milk","due":"2026-11-05","remind_at":"08:30"}' } });
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

    // A follow-up: the earlier messages go along, an answer after its steps replayed as the
    // tool calls they were, with what each did as the result.
    await chat(api, 'Which car is it again?');
    const replayed = sent[3]!.messages.slice(1) as { role: string; content: string | null; tool_calls?: { function: { name: string; arguments: string } }[]; tool_call_id?: string }[];
    expect(replayed.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'tool', 'tool', 'assistant', 'user']);
    expect(replayed[1]!.tool_calls!.map((c) => [c.function.name, JSON.parse(c.function.arguments)])).toEqual([
      ['calendar', { from: '2026-11-04', to: '2026-11-10' }],
      ['search_notes', { query: 'car' }],
      ['read_page', { page: 'Car' }],
    ]);
    expect(replayed.slice(2, 5).map((m) => JSON.parse(m.content!))).toEqual([
      { done: 'Looked at the calendar 2026-11-04 – 2026-11-10' },
      { done: 'Searched for “car” (1 found)' },
      { done: 'Read “Car”' },
    ]);
    expect(replayed.slice(5).map((m) => [m.role, m.content])).toEqual([
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

  it('replays an answer that called nothing as text alone, and keeps long arguments short', async () => {
    const api = await signedIn();
    const nb = (await api.call<Notebook>('POST', '/api/notebooks', { title: 'Games' })).body;
    await api.call('POST', '/api/pages', { notebookId: nb.id, title: 'Log', content: '' });
    const sent = fakeModel([
      { content: 'Added both tasks.' },
      { calls: [{ name: 'append_to_page', args: { page: 'Log', text: 'x'.repeat(1000) } }] },
      { content: 'Now they are there.' },
      { content: 'OK.' },
    ]);
    await chat(api, 'Add two tasks');
    await chat(api, 'I do not see them');
    // No tool call to show for the first answer: the model sees that.
    expect(sent[1]!.messages.slice(1, 3)).toEqual([
      { role: 'user', content: 'Add two tasks' },
      { role: 'assistant', content: 'Added both tasks.' },
    ]);
    await chat(api, 'Thanks');
    const call = (sent[3]!.messages.find((m) => m.tool_calls) as { tool_calls: { function: { arguments: string } }[] }).tool_calls[0]!;
    expect(JSON.parse(call.function.arguments)).toEqual({ page: 'Log', text: `${'x'.repeat(300)}…` });
  });

  it('says where pages are, and creates, moves and renames them', async () => {
    const api = await signedIn();
    const games = (await api.call<Notebook>('POST', '/api/notebooks', { title: 'Games' })).body;
    const idleon = (await api.call<Page>('POST', '/api/pages', { notebookId: games.id, title: 'IdleOn', content: '' })).body;
    const todo = (await api.call<Page>('POST', '/api/pages', { notebookId: games.id, title: "IdleOn ToDo's", content: '' })).body;
    await api.call<Page>('POST', '/api/pages', { notebookId: games.id, title: 'Plan', content: "See [[IdleOn ToDo's]]." });
    const sent = fakeModel([
      { calls: [{ name: 'read_page', args: { page: todo.id } }, { name: 'create_page', args: { notebook: 'Games', parent: 'IdleOn', title: 'Bosses', content: '' } }] },
      { calls: [{ name: 'move_page', args: { page: todo.id, parent: 'IdleOn', title: "IdleOn To-Do's" } }, { name: 'move_page', args: { page: 'IdleOn', parent: 'Bosses' } }] },
      { content: 'Moved.' },
    ]);
    const events = await chat(api, 'Tidy up my IdleOn pages');
    const actions = events.filter((e) => e.type === 'action').map((e) => (e as Extract<ChatEvent, { type: 'action' }>).action);
    expect(actions.map((a) => [a.ok, a.summary])).toEqual([
      [true, "Read “IdleOn ToDo's”"],
      [true, 'Created “Games › IdleOn › Bosses”'],
      [true, "Moved “IdleOn ToDo's” to “Games › IdleOn › IdleOn To-Do's”"],
      [false, 'move page: A page cannot be moved into itself'],
    ]);
    expect(JSON.parse(sent[1]!.messages.find((m) => m.tool_call_id === 'call_1_0')!.content!)).toMatchObject({ path: "Games › IdleOn ToDo's" });
    const moved = (await api.call<Page>('GET', `/api/pages/${todo.id}`)).body;
    expect(moved).toMatchObject({ title: "IdleOn To-Do's", parentId: idleon.id });
    // Links to the renamed page follow it.
    const plan = (await api.call<{ id: string; title: string }[]>('GET', '/api/pages')).body.find((p) => p.title === 'Plan')!;
    expect((await api.call<Page>('GET', `/api/pages/${plan.id}`)).body.content).toBe("See [[IdleOn To-Do's]].");
  });

  it('deletes a page only once the user confirms', async () => {
    const api = await signedIn();
    const nb = (await api.call<Notebook>('POST', '/api/notebooks', { title: 'Games' })).body;
    const old = (await api.call<Page>('POST', '/api/pages', { notebookId: nb.id, title: 'Old list', content: '' })).body;
    await api.call<Page>('POST', '/api/pages', { notebookId: nb.id, parentId: old.id, title: 'Old notes', content: '' });
    const sent = fakeModel([{ calls: [{ name: 'delete_page', args: { page: 'Old list' } }] }, { content: 'Press the button to delete it.' }, { content: 'OK.' }]);
    const events = await chat(api, 'Delete the old list');
    const action = (events[1] as Extract<ChatEvent, { type: 'action' }>).action;
    expect(action).toEqual({
      tool: 'delete_page',
      summary: 'Delete “Games › Old list” and its subpage?',
      pageId: old.id,
      ok: true,
      confirm: { id: expect.any(String), state: 'pending', yes: 'Move to trash', no: 'Keep it' },
      args: '{"page":"Old list"}',
    });
    expect(JSON.parse(sent[1]!.messages.at(-1)!.content!)).toEqual({ waiting_for_user: true, path: 'Games › Old list', subpages: 1 });
    expect((await api.call('GET', `/api/pages/${old.id}`)).status).toBe(200);

    // The next message tells the model the step still waits.
    await chat(api, 'Thanks');
    expect(JSON.parse(sent[2]!.messages[3]!.content!)).toEqual({ waiting_for_user: 'Delete “Games › Old list” and its subpage?' });

    const confirmed = await api.call<ChatEntry>('POST', `/api/chat/actions/${action.confirm!.id}`, { confirm: true });
    expect(confirmed.body.actions[0]).toMatchObject({ summary: 'Moved “Old list” and its subpage to the trash', confirm: { state: 'done' } });
    expect((await api.call('GET', `/api/pages/${old.id}`)).status).toBe(404);
    expect((await api.call('POST', `/api/chat/actions/${action.confirm!.id}`, { confirm: true })).status).toBe(409);
    expect((await api.call('POST', '/api/chat/actions/nope', { confirm: true })).status).toBe(404);
  });

  it('keeps a page when the user declines', async () => {
    const api = await signedIn();
    const nb = (await api.call<Notebook>('POST', '/api/notebooks', { title: 'Games' })).body;
    const page = (await api.call<Page>('POST', '/api/pages', { notebookId: nb.id, title: 'Keeper', content: '' })).body;
    fakeModel([{ calls: [{ name: 'delete_page', args: { page: 'Keeper' } }] }, { content: 'Confirm, please.' }]);
    const action = ((await chat(api, 'Delete Keeper'))[1] as Extract<ChatEvent, { type: 'action' }>).action;
    const declined = await api.call<ChatEntry>('POST', `/api/chat/actions/${action.confirm!.id}`, { confirm: false });
    expect(declined.body.actions[0]).toMatchObject({ summary: 'Kept it: “Games › Keeper”', confirm: { state: 'declined' } });
    expect((await api.call('GET', `/api/pages/${page.id}`)).status).toBe(200);
  });

  it('knows which notebooks exist, and lists pages as a tree and the journal\'s days', async () => {
    const api = await signedIn();
    const games = (await api.call<Notebook>('POST', '/api/notebooks', { title: 'Games' })).body;
    const idleon = (await api.call<Page>('POST', '/api/pages', { notebookId: games.id, title: 'IdleOn', content: '' })).body;
    const todo = (await api.call<Page>('POST', '/api/pages', { notebookId: games.id, parentId: idleon.id, title: "IdleOn To-Do's", content: '' })).body;
    await api.call('POST', '/api/daily', { date: '2026-11-03' });
    await api.call('POST', '/api/daily', { date: '2026-10-28' });
    const sent = fakeModel([{ calls: [{ name: 'list_pages', args: {} }, { name: 'list_journal', args: { from: '2026-11-01' } }] }, { content: 'Here it is.' }]);
    await chat(api, 'Show me a tree of my notes');

    expect(sent[0]!.messages[0]!.content).toContain('Their notes right now: notebooks "Games" (2 pages), "Journal" (');
    expect(sent[0]!.messages[0]!.content).toContain('The journal has notes for 2 days, 2026-10-28 to 2026-11-03.');
    const [tree, journal] = sent[1]!.messages.filter((m) => m.role === 'tool').map((m) => JSON.parse(m.content!));
    expect(tree.tree.split('\n').slice(0, 3)).toEqual(['Games (notebook, 2 pages)', `  - IdleOn [${idleon.id}]`, `    - IdleOn To-Do's [${todo.id}]`]);
    expect(tree.tree).toContain('Journal (notebook,');
    expect(journal).toEqual({ days: 1, notes: [{ date: '2026-11-03', id: expect.any(String) }] });
  });

  it('answers questions about Nicotes from its user guide', async () => {
    const api = await signedIn();
    const sent = fakeModel([
      { calls: [{ name: 'nicotes_help', args: { question: 'canvas drawing' } }, { name: 'nicotes_help', args: { question: 'telegram bot token' } }] },
      { content: 'Use "New canvas" in the ⋯ menu.' },
    ]);
    const events = await chat(api, 'Wie kann ich zeichnen?');
    const [canvas, telegram] = sent[1]!.messages.filter((m) => m.role === 'tool').map((m) => JSON.parse(m.content!) as { sections: { title: string; text: string }[]; contents: string[] });
    expect(canvas!.sections[0]!.title).toBe('Features › Writing');
    expect(canvas!.sections[0]!.text).toContain('New canvas');
    expect(canvas!.contents).toEqual(expect.arrayContaining(['Quick start', 'Features › Chat (optional)', 'Backups']));
    expect(telegram!.sections.map((s) => s.title)).toContain('Features › Tasks and connections');
    const actions = events.filter((e) => e.type === 'action').map((e) => (e as Extract<ChatEvent, { type: 'action' }>).action.summary);
    expect(actions[0]).toBe('Looked up “Features › Writing” in the Nicotes guide');
    expect(sent[0]!.messages[0]!.content).toContain('nicotes_help');
  });

  it('lets the model decide when the service cannot be made to call a tool', async () => {
    const api = await signedIn();
    const choices: string[] = [];
    vi.stubGlobal('fetch', async (_input: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Sent;
      choices.push(body.tool_choice);
      if (body.tool_choice === 'required') return Response.json({ error: { message: 'tool_choice "required" is not supported' } }, { status: 400 });
      return Response.json({ choices: [{ message: { content: 'Hello!' } }], usage: { cost: 0 } });
    });
    const events = await chat(api, 'Hi');
    expect(choices).toEqual(['required', 'auto']);
    expect((events.at(-1) as Extract<ChatEvent, { type: 'answer' }>).entry.content).toBe('Hello!');
  });

  it('stops calling tools after eight rounds and answers', async () => {
    const api = await signedIn();
    const sent = fakeModel([...Array.from({ length: 8 }, () => ({ calls: [{ name: 'list_notebooks', args: {} }] })), { content: 'Here is what I found.' }]);
    const events = await chat(api, 'Loop forever');
    expect(sent).toHaveLength(9);
    // The first round has to call a tool, the last one has to answer.
    expect(sent.map((s) => s.tool_choice)).toEqual(['required', ...Array(7).fill('auto'), 'none']);
    expect((events.at(-1) as Extract<ChatEvent, { type: 'answer' }>).entry.content).toBe('Here is what I found.');
  });

  it('says what is missing without an AI key', async () => {
    const api = setup();
    await api.call('POST', '/api/auth/setup', { username: 'nico', password: 'secret-pass' });
    const events = await chat(api, 'Hello');
    expect(events).toEqual([{ type: 'error', error: 'The chat needs an OpenRouter API key — add one under Settings.' }]);
  });
});
