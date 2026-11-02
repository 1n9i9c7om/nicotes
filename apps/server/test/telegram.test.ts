import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Notebook, Page } from '@nicotes/shared';
import { splitMessage, telegramHtml, type TelegramApi, type TelegramUpdate } from '../src/telegram.js';
import { setup } from './helpers.js';

describe('Telegram formatting', () => {
  it('turns Markdown into Telegram HTML', () => {
    const link = (t: string) => (t === 'Car' ? 'https://notes.example.com/p/abc' : null);
    const html = telegramHtml(
      [
        '## Friday',
        '- Book the **service** for the [[Car]] & tyres <soon>',
        '- [ ] Call *Bob* about `x < y`',
        '- [x] Done thing',
        'See [the site](https://example.com) and [[Unknown|that page]].',
        '```',
        'a <b> c',
        '```',
      ].join('\n'),
      link,
    );
    expect(html).toBe(
      [
        '<b>Friday</b>',
        '• Book the <b>service</b> for the <a href="https://notes.example.com/p/abc">Car</a> &amp; tyres &lt;soon&gt;',
        '☐ Call <i>Bob</i> about <code>x &lt; y</code>',
        '☑ Done thing',
        'See <a href="https://example.com">the site</a> and <b>that page</b>.',
        '<pre>a &lt;b&gt; c</pre>',
      ].join('\n'),
    );
  });

  it('splits long answers at paragraphs', () => {
    const parts = splitMessage(`${'a'.repeat(3000)}\n\n${'b'.repeat(3000)}`);
    expect(parts.map((p) => p.length)).toEqual([3000, 3000]);
  });
});

/** A fake Telegram: updates are handed out once, everything sent is kept. */
function fakeTelegram() {
  const sent: { method: string; body: Record<string, unknown> }[] = [];
  let queue: TelegramUpdate[] = [];
  let id = 1;
  const api: TelegramApi = async (_token, method, body) => {
    if (method === 'getMe') return { username: 'nicotes_test_bot' };
    if (method === 'getUpdates') {
      await new Promise((r) => setTimeout(r, 5));
      const batch = queue;
      queue = [];
      return batch;
    }
    sent.push({ method, body: body as Record<string, unknown> });
    return { message_id: 100 };
  };
  const push = (update: Omit<TelegramUpdate, 'update_id'>) => queue.push({ update_id: id++, ...update });
  return { api, sent, push };
}

const settle = async (check: () => boolean) => {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 10));
};

afterEach(() => vi.unstubAllGlobals());

describe('Telegram chat', () => {
  it('answers the linked chat with tasks, the calendar and the assistant', async () => {
    const tg = fakeTelegram();
    const api = setup({ reminders: { telegram: tg.api } });
    await api.call('POST', '/api/auth/setup', { username: 'nico', password: 'secret-pass' });
    await api.call('PATCH', '/api/settings', { telegramBotToken: '123:good', openrouterApiKey: 'sk-or-test', reminderTimeZone: 'UTC' });
    const nb = (await api.call<Notebook>('POST', '/api/notebooks', { title: 'Home' })).body;
    const today = new Date().toISOString().slice(0, 10);
    const page = (await api.call<Page>('POST', '/api/pages', { notebookId: nb.id, title: 'Chores', content: `- [ ] Water the plants 📅 ${today}` })).body;

    const { url } = (await api.call<{ url: string }>('POST', '/api/reminders/telegram/link')).body;
    tg.push({ message: { message_id: 1, chat: { id: 42 }, text: `/start ${new URL(url).searchParams.get('start')}` } });
    await settle(() => tg.sent.some((s) => s.method === 'sendMessage'));
    expect(tg.sent.find((s) => s.method === 'sendMessage')!.body.text).toMatch(/^Connected to Nicotes ✓ .*\/todo/);

    // /todo lists the task with a button that ticks it off.
    tg.push({ message: { message_id: 2, chat: { id: 42 }, text: '/todo' } });
    await settle(() => tg.sent.filter((s) => s.method === 'sendMessage').length === 2);
    const todo = tg.sent.filter((s) => s.method === 'sendMessage')[1]!.body;
    expect(todo.text).toContain('<b>Today</b>\n☐ Water the plants');
    const button = (todo.reply_markup as { inline_keyboard: { text: string; callback_data: string }[][] }).inline_keyboard[0]![0]!;
    expect(button.text).toBe('✓ Water the plants');
    tg.push({ callback_query: { id: 'q1', data: button.callback_data, message: { message_id: 7, chat: { id: 42 } } } });
    await settle(() => tg.sent.some((s) => s.method === 'editMessageText'));
    expect(tg.sent.find((s) => s.method === 'answerCallbackQuery')!.body).toEqual({ callback_query_id: 'q1', text: 'Done: Water the plants' });
    expect(tg.sent.find((s) => s.method === 'editMessageText')!.body.text).toBe('No open tasks. 🎉');
    expect((await api.call<Page>('GET', `/api/pages/${page.id}`)).body.content).toBe(`- [x] Water the plants 📅 ${today}`);

    // The calendar shows the week, done tasks struck through.
    tg.push({ message: { message_id: 3, chat: { id: 42 }, text: '/calendar' } });
    await settle(() => tg.sent.filter((s) => s.method === 'sendMessage').length === 3);
    const week = tg.sent.filter((s) => s.method === 'sendMessage')[2]!.body;
    expect(week.text).toContain('▸ <b>');
    expect(week.text).toContain('☑ <s>Water the plants</s>');

    // Anything else goes to the assistant; another chat is ignored. What it does in Nicotes
    // shows up as steps (one message, edited as they come), then the answer.
    const prompts: string[] = [];
    const replies = [
      { tool_calls: [{ id: 'c1', type: 'function', function: { name: 'list_tasks', arguments: '{}' } }] },
      { tool_calls: [{ id: 'c2', type: 'function', function: { name: 'read_page', arguments: JSON.stringify({ page: page.id }) } }] },
      { content: 'All done for today, see [[Chores]].' },
    ];
    vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { messages: { role: string; content: string }[] };
      if (body.messages.at(-1)!.role === 'user') prompts.push(body.messages.at(-1)!.content);
      return Response.json({ choices: [{ message: replies.shift() }], usage: { cost: 0 } });
    });
    tg.push({ message: { message_id: 4, chat: { id: 99 }, text: 'Hello from a stranger' } });
    tg.push({ message: { message_id: 5, chat: { id: 42 }, text: 'Anything left today?' } });
    await settle(() => tg.sent.filter((s) => s.method === 'sendMessage').length === 5);
    expect(prompts).toEqual(['Anything left today?']);
    const [steps, reply] = tg.sent.filter((s) => s.method === 'sendMessage').slice(3).map((s) => s.body);
    expect(steps).toMatchObject({ chat_id: 42, parse_mode: 'HTML', text: '<blockquote expandable>☑️ Looked at the tasks (0)</blockquote>' });
    expect(tg.sent.find((s) => s.method === 'editMessageText' && s.body.message_id === 100)!.body.text).toBe(
      `<blockquote expandable>☑️ Looked at the tasks (0)\n📄 <a href="http://localhost/p/${page.id}">Read “Chores”</a></blockquote>`,
    );
    expect(reply).toMatchObject({ chat_id: 42, parse_mode: 'HTML', text: `All done for today, see <a href="http://localhost/p/${page.id}">Chores</a>.` });
    expect(tg.sent.some((s) => s.method === 'sendChatAction')).toBe(true);
    expect(tg.sent.every((s) => s.body.chat_id !== 99)).toBe(true);

    // Deleting a page waits for a button press.
    const old = (await api.call<Page>('POST', '/api/pages', { notebookId: nb.id, title: 'Old', content: '' })).body;
    replies.push(
      { tool_calls: [{ id: 'c3', type: 'function', function: { name: 'delete_page', arguments: JSON.stringify({ page: 'Old' }) } }] },
      { content: 'Confirm below.' },
    );
    tg.push({ message: { message_id: 6, chat: { id: 42 }, text: 'Delete the page Old' } });
    await settle(() => tg.sent.filter((s) => s.method === 'sendMessage').length === 8);
    const question = tg.sent.filter((s) => s.method === 'sendMessage')[7]!.body;
    expect(question.text).toBe('Delete “Home › Old”?');
    const [yes, no] = (question.reply_markup as { inline_keyboard: { text: string; callback_data: string }[][] }).inline_keyboard[0]!;
    expect([yes!.text, no!.text]).toEqual(['✓ Move to trash', 'Keep it']);
    expect((await api.call('GET', `/api/pages/${old.id}`)).status).toBe(200);
    tg.push({ callback_query: { id: 'q2', data: yes!.callback_data, message: { message_id: 8, chat: { id: 42 } } } });
    await settle(() => tg.sent.some((s) => s.method === 'editMessageText' && s.body.message_id === 8));
    expect(tg.sent.find((s) => s.method === 'editMessageText' && s.body.message_id === 8)!.body.text).toBe('Moved “Old” to the trash');
    expect((await api.call('GET', `/api/pages/${old.id}`)).status).toBe(404);

    // /new forgets the Telegram conversation (the web chat is separate).
    tg.push({ message: { message_id: 7, chat: { id: 42 }, text: '/new' } });
    await settle(() => tg.sent.filter((s) => s.method === 'sendMessage').length === 9);
    expect(tg.sent.filter((s) => s.method === 'sendMessage')[8]!.body.text).toMatch(/^Started a new conversation/);
    api.reminders.stop();
  });
});
