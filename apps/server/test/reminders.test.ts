import { describe, expect, it } from 'vitest';
import type { Notebook, Page, PushDevice, ReminderNotice, ReminderStatus, ReminderTestResult } from '@nicotes/shared';
import { localTime, TelegramError, type PushSender, type TelegramApi } from '../src/reminders.js';
import { setup } from './helpers.js';

// 2026-11-04 is in winter time: Berlin is UTC+1.
const at = (iso: string) => Date.parse(iso);

function fakes() {
  let now = at('2026-11-04T06:00:00Z');
  const pushed: { endpoint: string; notice: ReminderNotice; subject: string }[] = [];
  const gone = new Set<string>();
  const sendPush: PushSender = async (sub, payload, options) => {
    if (gone.has(sub.endpoint)) throw Object.assign(new Error('Gone'), { statusCode: 410 });
    pushed.push({ endpoint: sub.endpoint, notice: JSON.parse(payload) as ReminderNotice, subject: options.vapidDetails.subject });
    return { statusCode: 201 };
  };
  const sent: { chat_id: unknown; text: string }[] = [];
  let updates: unknown[] = [];
  const telegram: TelegramApi = async (token, method, body) => {
    if (token !== '123:good') throw new TelegramError('Unauthorized', 401);
    if (method === 'getMe') return { username: 'nicotes_test_bot' };
    if (method === 'sendMessage') {
      sent.push(body as { chat_id: unknown; text: string });
      return {};
    }
    if (method === 'getUpdates') {
      await new Promise((r) => setTimeout(r, 5));
      const batch = updates;
      updates = [];
      return batch;
    }
    throw new Error(`unexpected ${method}`);
  };
  return {
    options: { sendPush, telegram, now: () => now },
    setNow: (iso: string) => (now = at(iso)),
    pushed,
    gone,
    sent,
    deliver: (u: unknown[]) => (updates = u),
  };
}

async function withTasks(f: ReturnType<typeof fakes>) {
  const api = setup({ reminders: f.options });
  await api.call('POST', '/api/auth/setup', { username: 'nico', password: 'secret-pass' });
  await api.call('PATCH', '/api/settings', { reminderTimeZone: 'Europe/Berlin' });
  const nb = (await api.call<Notebook>('POST', '/api/notebooks', { title: 'Home' })).body;
  const page = (
    await api.call<Page>('POST', '/api/pages', {
      notebookId: nb.id,
      title: 'Errands',
      content: [
        '- [ ] Call mum ⏰ 09:00 📅 2026-11-04',
        '- [ ] Water plants ⏰ 2026-11-04 05:00',
        '- [x] Done already ⏰ 08:00 📅 2026-11-04',
        '- [ ] Buy **milk** 📅 2026-11-04',
        '- [ ] File taxes 📅 2026-11-01',
      ].join('\n'),
    })
  ).body;
  const subscribe = (endpoint: string) =>
    api.call<PushDevice>('POST', '/api/reminders/push', { endpoint, keys: { p256dh: 'BKey', auth: 'secret' }, name: 'Phone' });
  return { api, page, subscribe };
}

describe('reminders', () => {
  it('works out local dates and times in a time zone', () => {
    expect(localTime(at('2026-11-04T23:30:00Z'), 'Europe/Berlin')).toEqual({ date: '2026-11-05', time: '00:30' });
    expect(localTime(at('2026-07-04T23:30:00Z'), 'America/New_York')).toEqual({ date: '2026-07-04', time: '19:30' });
  });

  it('pushes a task at its time, once, and never hours late', async () => {
    const f = fakes();
    const { api, page, subscribe } = await withTasks(f);
    expect((await subscribe('https://push.example/abc')).status).toBe(201);
    const status = (await api.call<ReminderStatus>('GET', '/api/reminders')).body;
    expect(status.vapidPublicKey).toMatch(/^[A-Za-z0-9_-]{87}$/);
    expect(status.devices.map((d) => d.name)).toEqual(['Phone']);

    f.setNow('2026-11-04T07:59:00Z'); // 08:59 in Berlin
    await api.reminders.tick();
    expect(f.pushed).toEqual([]);

    f.setNow('2026-11-04T08:00:00Z');
    await api.reminders.tick();
    await api.reminders.tick();
    expect(f.pushed.map((p) => p.notice)).toEqual([
      { title: 'Call mum', body: 'From “Errands”', url: `/p/${page.id}`, tag: expect.stringMatching(/^task:/) },
    ]);
    // "Water plants" was due at 05:00 Berlin time, three hours before: too late to remind.
    // Without an https address, the push services get the project as contact.
    expect(f.pushed[0]!.subject).toBe('https://github.com/1n9i9c7om/nicotes');
  });

  it('sends the morning summary once a day', async () => {
    const f = fakes();
    const { api, subscribe } = await withTasks(f);
    await subscribe('https://push.example/abc');
    await api.call('PATCH', '/api/settings', { reminderDigestTime: '07:30' });

    f.setNow('2026-11-04T06:29:00Z');
    await api.reminders.tick();
    expect(f.pushed).toEqual([]);
    f.setNow('2026-11-04T06:31:00Z');
    await api.reminders.tick();
    f.setNow('2026-11-04T06:45:00Z');
    await api.reminders.tick();
    expect(f.pushed.map((p) => p.notice)).toEqual([
      { title: '2 tasks due today', body: '• Call mum\n• Buy milk\nPlus 1 overdue task.', url: '/tasks', tag: 'digest' },
    ]);
  });

  it('forgets devices that unsubscribed', async () => {
    const f = fakes();
    const { api, subscribe } = await withTasks(f);
    await subscribe('https://push.example/old');
    f.gone.add('https://push.example/old');
    const results = (await api.call<ReminderTestResult[]>('POST', '/api/reminders/test')).body;
    expect(results).toEqual([{ channel: 'push', target: 'Phone', ok: false, message: 'No longer subscribed; removed' }]);
    expect((await api.call<ReminderStatus>('GET', '/api/reminders')).body.devices).toEqual([]);
    expect((await api.call('POST', '/api/reminders/test')).status).toBe(409);
  });

  it('links a Telegram chat with /start and a one-time code', async () => {
    const f = fakes();
    const { api } = await withTasks(f);
    await api.call('PATCH', '/api/settings', { telegramBotToken: '123:wrong' });
    expect((await api.call<ReminderStatus>('GET', '/api/reminders')).body.telegram).toEqual({
      bot: null,
      connected: false,
      linkUrl: null,
      error: 'Telegram does not accept this bot token',
    });

    await api.call('PATCH', '/api/settings', { telegramBotToken: '123:good' });
    const { url } = (await api.call<{ url: string }>('POST', '/api/reminders/telegram/link')).body;
    expect(url).toMatch(/^https:\/\/t\.me\/nicotes_test_bot\?start=[A-Za-z0-9_-]{16}$/);
    const code = new URL(url).searchParams.get('start');
    expect((await api.call<ReminderStatus>('GET', '/api/reminders')).body.telegram.linkUrl).toBe(url);

    f.deliver([
      { update_id: 7, message: { chat: { id: 99 }, text: '/start wrong-code' } },
      { update_id: 8, message: { chat: { id: 42 }, text: `/start ${code}` } },
    ]);
    for (let i = 0; i < 50 && !(await api.call<ReminderStatus>('GET', '/api/reminders')).body.telegram.connected; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const telegram = (await api.call<ReminderStatus>('GET', '/api/reminders')).body.telegram;
    expect(telegram).toEqual({ bot: 'nicotes_test_bot', connected: true, linkUrl: null, error: null });
    expect(f.sent.map((m) => m.chat_id)).toEqual([99, 42]);

    const results = (await api.call<ReminderTestResult[]>('POST', '/api/reminders/test')).body;
    expect(results).toEqual([{ channel: 'telegram', target: 'Telegram', ok: true, message: 'Sent' }]);
    expect(f.sent.at(-1)).toMatchObject({ chat_id: '42', text: expect.stringContaining('<b>Test reminder</b>') });
    expect(f.sent.at(-1)!.text).toContain('<a href="http://localhost/tasks">Open in Nicotes</a>');

    // Another bot cannot write to that chat: changing the token disconnects it.
    await api.call('PATCH', '/api/settings', { telegramBotToken: '123:other' });
    expect((await api.call<ReminderStatus>('GET', '/api/reminders')).body.telegram.connected).toBe(false);
    api.reminders.stop();
  });

  it('is only open to the signed-in owner', async () => {
    const f = fakes();
    const { api } = await withTasks(f);
    const { token } = (await api.call<{ token: string }>('POST', '/api/tokens', { name: 'Script', scope: 'write' })).body;
    expect((await api.request('/api/reminders', { headers: { authorization: `Bearer ${token}` } })).status).toBe(403);
  });
});
