import { createHash, randomBytes } from 'node:crypto';
import { and, count, eq, lt, max } from 'drizzle-orm';
import webpush from 'web-push';
import {
  taskPlainText,
  type PageTask,
  type PushDevice,
  type PushSubscribe,
  type ReminderNotice,
  type ReminderStatus,
  type ReminderTestResult,
} from '@nicotes/shared';
import type { Db } from './db/index.js';
import { pages, pushSubscriptions, remindersSent, users } from './db/schema.js';
import { newId } from './ids.js';
import { BOT_COMMANDS, TelegramBot, type BotChat, type TelegramApi, type TelegramUpdate } from './telegram.js';
import { localTime } from './time.js';
import { Pending } from './pending.js';
import { listTasks } from './routes/tasks.js';
import type { SettingsStore } from './settings.js';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
/** Reminders missed while the server was off still go out when it is back, this late at most. */
const GRACE_MINUTES = 120;
/** Where push services can reach whoever runs this server, when it has no https address. */
const FALLBACK_CONTACT = 'https://github.com/1n9i9c7om/nicotes';

export type PushSender = (
  subscription: { endpoint: string; keys: { p256dh: string; auth: string } },
  payload: string,
  options: { vapidDetails: { subject: string; publicKey: string; privateKey: string }; TTL: number; urgency: 'high'; timeout: number },
) => Promise<{ statusCode: number }>;

export type { TelegramApi };

export { localTime };

export class TelegramError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

const telegramApi: TelegramApi = async (token, method, body, signal) => {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: signal ?? AbortSignal.timeout(15_000),
  });
  const data = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: unknown; description?: string };
  if (!data.ok) throw new TelegramError(data.description ?? `Telegram answered ${res.status}`, res.status);
  return data.result;
};

export interface ReminderOptions {
  /** Tests: fakes for the push services and Telegram, and the clock. */
  sendPush?: PushSender;
  telegram?: TelegramApi;
  now?: () => number;
}

const minutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const escapeHtml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const clip = (text: string, length: number) => (text.length > length ? `${text.slice(0, length - 1)}…` : text);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * Reminders for tasks: at the time written after a task (`⏰ 09:00`), and an optional summary
 * of the day's tasks, as push notifications and/or Telegram messages. Checks once a minute;
 * `reminders_sent` makes sure each one goes out once.
 */
export class ReminderService {
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private stopped = false;
  private tasks = new Map<string, { stamp: string; at: number; list: PageTask[] }>();
  private attempts = new Map<string, number>();
  /** Codes in t.me links waiting for /start, per account. */
  private links = new Pending<{ userId: string; token: string }>(10 * MINUTE);
  private polling = new Set<string>();
  private bots = new Map<string, { name: string | null; error: string | null; at: number }>();
  private sendPush: PushSender;
  private telegram: TelegramApi;
  private now: () => number;
  /** Answers the linked chat: commands, buttons, and the chat assistant. */
  private telegramBot: TelegramBot;

  constructor(
    private db: Db,
    private settings: SettingsStore,
    options: ReminderOptions = {},
  ) {
    this.sendPush = options.sendPush ?? ((sub, payload, opts) => webpush.sendNotification(sub, payload, opts));
    this.telegram = options.telegram ?? telegramApi;
    this.now = options.now ?? Date.now;
    this.telegramBot = new TelegramBot(db, settings, this.telegram, this.now);
    settings.onUpdate((userId, input) => {
      // Another bot cannot write to the chat the old one was linked to.
      if (input.telegramBotToken !== undefined) settings.setInternal(userId, 'telegram.chatId', null);
    });
  }

  start() {
    this.pollLinked();
    this.timer = setInterval(() => void this.tick(), MINUTE);
    this.timer.unref();
    setTimeout(() => void this.tick(), 10_000).unref();
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
  }

  /** The address the app was last used at, for links in Telegram messages. */
  rememberAppUrl(userId: string, origin: string) {
    if (this.settings.internal(userId, 'appUrl') !== origin) this.settings.setInternal(userId, 'appUrl', origin);
  }

  // ---------- Push ----------

  /** The account's VAPID key pair, made on first use; subscriptions are tied to it. */
  vapidKeys(userId: string): { publicKey: string; privateKey: string } {
    const publicKey = this.settings.internal(userId, 'push.vapidPublic');
    const privateKey = this.settings.internal(userId, 'push.vapidPrivate', true);
    if (publicKey && privateKey) return { publicKey, privateKey };
    const keys = webpush.generateVAPIDKeys();
    this.settings.setInternal(userId, 'push.vapidPublic', keys.publicKey);
    this.settings.setInternal(userId, 'push.vapidPrivate', keys.privateKey, true);
    // The private key could not be decrypted (NICOTES_SECRET changed): subscriptions made
    // for the old key can no longer be used.
    if (publicKey) this.db.delete(pushSubscriptions).where(eq(pushSubscriptions.userId, userId)).run();
    return keys;
  }

  devices(userId: string): PushDevice[] {
    return this.db
      .select({
        id: pushSubscriptions.id,
        name: pushSubscriptions.name,
        endpoint: pushSubscriptions.endpoint,
        createdAt: pushSubscriptions.createdAt,
        lastSentAt: pushSubscriptions.lastSentAt,
      })
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.userId, userId))
      .all();
  }

  subscribe(userId: string, input: PushSubscribe): PushDevice {
    this.vapidKeys(userId);
    const values = { userId, p256dh: input.keys.p256dh, auth: input.keys.auth, name: input.name, createdAt: this.now(), lastSentAt: null };
    // A browser has one subscription per site; subscribing again replaces it.
    const row = this.db
      .insert(pushSubscriptions)
      .values({ id: newId(), endpoint: input.endpoint, ...values })
      .onConflictDoUpdate({ target: pushSubscriptions.endpoint, set: values })
      .returning()
      .get();
    return { id: row.id, name: row.name, endpoint: row.endpoint, createdAt: row.createdAt, lastSentAt: row.lastSentAt };
  }

  unsubscribe(userId: string, id: string): boolean {
    return this.db.delete(pushSubscriptions).where(and(eq(pushSubscriptions.id, id), eq(pushSubscriptions.userId, userId))).run().changes > 0;
  }

  // ---------- Telegram ----------

  /** The bot's name (cached for a few minutes), or why it cannot be reached. */
  private async bot(token: string): Promise<{ name: string | null; error: string | null }> {
    const cached = this.bots.get(token);
    if (cached && this.now() - cached.at < 5 * MINUTE) return cached;
    let entry: { name: string | null; error: string | null; at: number };
    try {
      const me = (await this.telegram(token, 'getMe', {})) as { username?: string };
      entry = { name: me.username ?? null, error: null, at: this.now() };
    } catch (err) {
      const message = err instanceof TelegramError && err.status === 401 ? 'Telegram does not accept this bot token' : (err as Error).message;
      entry = { name: null, error: message, at: this.now() };
    }
    this.bots.set(token, entry);
    return entry;
  }

  async telegramStatus(userId: string): Promise<ReminderStatus['telegram']> {
    const token = this.settings.reminders(userId).telegramToken;
    if (!token) return { bot: null, connected: false, linkUrl: null, error: null };
    const { name, error } = await this.bot(token);
    const pending = this.settings.internal(userId, 'telegram.linkCode');
    const code = pending && this.links.get(pending)?.userId === userId ? pending : null;
    return {
      bot: name,
      connected: this.settings.internal(userId, 'telegram.chatId') !== null,
      linkUrl: code && name ? `https://t.me/${name}?start=${code}` : null,
      error,
    };
  }

  /** A t.me link that opens the bot with a one-time code; /start with it links the chat. */
  async startLink(userId: string): Promise<string> {
    const token = this.settings.reminders(userId).telegramToken;
    if (!token) throw new Error('Add the bot token first');
    const { name, error } = await this.bot(token);
    if (!name) throw new Error(error ?? 'The bot could not be reached');
    const code = randomBytes(12).toString('base64url');
    this.links.put({ userId, token }, code);
    this.settings.setInternal(userId, 'telegram.linkCode', code);
    void this.poll(token);
    return `https://t.me/${name}?start=${code}`;
  }

  disconnectTelegram(userId: string) {
    this.settings.setInternal(userId, 'telegram.chatId', null);
  }

  /** Lets linked Telegram chats talk to the chat assistant; they are listened to from now on. */
  useChat(chat: BotChat) {
    this.telegramBot.chat = chat;
    this.pollLinked();
  }

  private pollLinked() {
    if (!this.telegramBot.chat) return;
    const tokens = new Set(
      this.db
        .select({ id: users.id })
        .from(users)
        .all()
        .filter(({ id }) => this.settings.internal(id, 'telegram.chatId') !== null)
        .map(({ id }) => this.settings.reminders(id).telegramToken)
        .filter((t): t is string => !!t),
    );
    for (const token of tokens) void this.poll(token);
  }

  /** The account whose linked chat this is (for this bot). */
  private chatOwner(token: string, chatId: number): string | null {
    return (
      this.db
        .select({ id: users.id })
        .from(users)
        .all()
        .find(({ id }) => this.settings.internal(id, 'telegram.chatId') === String(chatId) && this.settings.reminders(id).telegramToken === token)?.id ??
      null
    );
  }

  /**
   * Long polling (no public address, as a webhook would need) while a link code waits and,
   * with the chat assistant, as long as a chat is linked to this bot.
   */
  private async poll(token: string) {
    if (this.polling.has(token)) return;
    this.polling.add(token);
    let offset = 0;
    if (this.telegramBot.chat) void this.telegram(token, 'setMyCommands', { commands: BOT_COMMANDS }).catch(() => {});
    try {
      while (!this.stopped && this.wanted(token)) {
        let updates: TelegramUpdate[];
        try {
          updates = (await this.telegram(token, 'getUpdates', { offset, timeout: 25, allowed_updates: ['message', 'callback_query'] }, AbortSignal.timeout(35_000))) as TelegramUpdate[];
        } catch {
          await new Promise((r) => setTimeout(r, 5000));
          continue;
        }
        for (const update of updates) {
          offset = update.update_id + 1;
          const message = update.message;
          const code = /^\/start\s+(\S+)/.exec(message?.text ?? '')?.[1];
          if (!code) {
            const chatId = message?.chat.id ?? update.callback_query?.message?.chat.id;
            const owner = chatId !== undefined && this.telegramBot.chat ? this.chatOwner(token, chatId) : null;
            if (owner) await this.telegramBot.handle(token, owner, update).catch((err) => console.error('Telegram chat failed:', err));
            continue;
          }
          if (!message) continue;
          const link = this.links.take(code);
          if (!link || link.token !== token) {
            await this.telegram(token, 'sendMessage', { chat_id: message.chat.id, text: 'Open the link from Nicotes (Settings → Reminders) to connect this chat.' }).catch(() => {});
            continue;
          }
          this.settings.setInternal(link.userId, 'telegram.chatId', String(message.chat.id));
          this.settings.setInternal(link.userId, 'telegram.linkCode', null);
          const more = this.telegramBot.chat ? ' You can also write to me, e.g. “What is due this week?”, or try /todo and /calendar.' : '';
          await this.telegram(token, 'sendMessage', { chat_id: message.chat.id, text: `Connected to Nicotes ✓ Reminders will arrive here.${more}` }).catch(() => {});
        }
      }
      // Confirms what was read (the next call with an offset does that), so it is not
      // delivered again when the next link starts polling.
      if (offset) await this.telegram(token, 'getUpdates', { offset, timeout: 0 }).catch(() => {});
    } finally {
      this.polling.delete(token);
    }
  }

  private wanted(token: string): boolean {
    if (this.waitingFor(token)) return true;
    return !!this.telegramBot.chat && this.db.select({ id: users.id }).from(users).all().some(({ id }) => this.settings.reminders(id).telegramToken === token && this.settings.internal(id, 'telegram.chatId') !== null);
  }

  private waitingFor(token: string): boolean {
    return this.db
      .select({ userId: users.id })
      .from(users)
      .all()
      .some(({ userId }) => {
        const code = this.settings.internal(userId, 'telegram.linkCode');
        return code !== null && this.links.get(code)?.token === token;
      });
  }

  // ---------- Sending ----------

  /** Sends a notice to every device and the linked chat; one result per target. */
  async deliver(userId: string, notice: ReminderNotice): Promise<ReminderTestResult[]> {
    const results: ReminderTestResult[] = [];
    const appUrl = this.settings.internal(userId, 'appUrl');
    const subs = this.db.select().from(pushSubscriptions).where(eq(pushSubscriptions.userId, userId)).all();
    if (subs.length) {
      const { publicKey, privateKey } = this.vapidKeys(userId);
      const subject = appUrl?.startsWith('https://') ? appUrl : FALLBACK_CONTACT;
      for (const sub of subs) {
        try {
          await this.sendPush({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, JSON.stringify(notice), {
            vapidDetails: { subject, publicKey, privateKey },
            TTL: DAY / 1000,
            urgency: 'high',
            timeout: 15_000,
          });
          this.db.update(pushSubscriptions).set({ lastSentAt: this.now() }).where(eq(pushSubscriptions.id, sub.id)).run();
          results.push({ channel: 'push', target: sub.name, ok: true, message: 'Sent' });
        } catch (err) {
          const status = (err as { statusCode?: number }).statusCode;
          // The browser unsubscribed or the app was removed: forget the device.
          if (status === 404 || status === 410) this.db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, sub.id)).run();
          const message = status === 404 || status === 410 ? 'No longer subscribed; removed' : (err as Error).message;
          results.push({ channel: 'push', target: sub.name, ok: false, message });
        }
      }
    }
    const token = this.settings.reminders(userId).telegramToken;
    const chatId = this.settings.internal(userId, 'telegram.chatId');
    if (token && chatId) {
      const link = appUrl ? `\n<a href="${escapeHtml(`${appUrl}${notice.url}`)}">Open in Nicotes</a>` : '';
      try {
        await this.telegram(token, 'sendMessage', {
          chat_id: chatId,
          text: `<b>${escapeHtml(notice.title)}</b>\n${escapeHtml(notice.body)}${link}`,
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: true },
        });
        results.push({ channel: 'telegram', target: 'Telegram', ok: true, message: 'Sent' });
      } catch (err) {
        results.push({ channel: 'telegram', target: 'Telegram', ok: false, message: (err as Error).message });
      }
    }
    return results;
  }

  private hasChannel(userId: string): boolean {
    const devices = this.db.select({ n: count() }).from(pushSubscriptions).where(eq(pushSubscriptions.userId, userId)).get()?.n ?? 0;
    return devices > 0 || (this.settings.reminders(userId).telegramToken !== null && this.settings.internal(userId, 'telegram.chatId') !== null);
  }

  /** Open tasks, parsed again only when pages changed (or every 10 minutes). */
  private openTasks(userId: string): PageTask[] {
    const excludeTags = this.settings.view(userId).tasks.excludeTags;
    const state = this.db
      .select({ n: count(), updated: max(pages.updatedAt), deleted: max(pages.deletedAt) })
      .from(pages)
      .where(eq(pages.userId, userId))
      .get();
    const stamp = `${state?.n}|${state?.updated}|${state?.deleted}|${excludeTags.join(',')}`;
    const cached = this.tasks.get(userId);
    if (cached && cached.stamp === stamp && this.now() - cached.at < 10 * MINUTE) return cached.list;
    const list = listTasks(this.db, userId, 'open', excludeTags);
    this.tasks.set(userId, { stamp, at: this.now(), list });
    return list;
  }

  /** Sends once per key: marked when at least one target got it, retried a few times otherwise. */
  private async once(userId: string, key: string, notice: ReminderNotice) {
    const where = and(eq(remindersSent.userId, userId), eq(remindersSent.key, key));
    if (this.db.select({ key: remindersSent.key }).from(remindersSent).where(where).get()) return;
    const attempt = `${userId}:${key}`;
    if ((this.attempts.get(attempt) ?? 0) >= 5) return;
    const results = await this.deliver(userId, notice);
    if (results.some((r) => r.ok) || !results.length) {
      this.db.insert(remindersSent).values({ userId, key, sentAt: this.now() }).onConflictDoNothing().run();
      this.attempts.delete(attempt);
    } else {
      this.attempts.set(attempt, (this.attempts.get(attempt) ?? 0) + 1);
      console.warn(`Reminder ${key} could not be sent: ${results.map((r) => `${r.target}: ${r.message}`).join('; ')}`);
    }
  }

  async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = this.now();
      this.db.delete(remindersSent).where(lt(remindersSent.sentAt, now - 3 * DAY)).run();
      for (const { id } of this.db.select({ id: users.id }).from(users).all()) {
        try {
          await this.remindUser(id, now);
        } catch (err) {
          console.error('Reminders failed:', err);
        }
      }
    } finally {
      this.ticking = false;
    }
  }

  private async remindUser(userId: string, now: number) {
    if (!this.hasChannel(userId)) return;
    const { digestTime, timeZone } = this.settings.reminders(userId);
    const zone = timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    const local = localTime(now, zone);
    const nowLocal = `${local.date}T${local.time}`;
    const earliest = localTime(now - GRACE_MINUTES * MINUTE, zone);
    const earliestLocal = `${earliest.date}T${earliest.time}`;
    const tasks = this.openTasks(userId);

    for (const task of tasks) {
      if (!task.remind || task.remind > nowLocal || task.remind < earliestLocal) continue;
      const key = `task:${createHash('sha256').update(`${task.pageId}\u0000${task.text}\u0000${task.remind}`).digest('hex').slice(0, 24)}`;
      await this.once(userId, key, {
        title: clip(taskPlainText(task.text) || 'Task', 120),
        body: `From “${task.pageTitle || 'Untitled'}”${task.due && task.due !== task.remind.slice(0, 10) ? ` · due ${task.due}` : ''}`,
        url: `/p/${task.pageId}`,
        tag: key,
      });
    }

    const since = digestTime ? minutes(local.time) - minutes(digestTime) : -1;
    if (digestTime && since >= 0 && since <= GRACE_MINUTES) {
      const today = tasks.filter((t) => t.due === local.date);
      const overdue = tasks.filter((t) => t.due && t.due < local.date);
      const key = `digest:${local.date}`;
      if (!today.length && !overdue.length) {
        this.db.insert(remindersSent).values({ userId, key, sentAt: now }).onConflictDoNothing().run();
        return;
      }
      const shown = (today.length ? today : overdue).slice(0, 6);
      const lines = shown.map((t) => `• ${clip(taskPlainText(t.text) || 'Task', 80)}`);
      const rest = (today.length || overdue.length) - shown.length;
      if (rest > 0) lines.push(`and ${rest} more`);
      if (today.length && overdue.length) lines.push(`Plus ${plural(overdue.length, 'overdue task')}.`);
      await this.once(userId, key, {
        title: today.length ? `${plural(today.length, 'task')} due today` : `${plural(overdue.length, 'task')} overdue`,
        body: lines.join('\n'),
        url: '/tasks',
        tag: 'digest',
      });
    }
  }
}
