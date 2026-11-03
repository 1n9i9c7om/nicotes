import { createHash } from 'node:crypto';
import { resolveWikilink, taskPlainText, type ChatAction, type PageTask } from '@nicotes/shared';
import type { Db } from './db/index.js';
import { loadLinkContext } from './links.js';
import { listTasks, updateTask } from './routes/tasks.js';
import type { SettingsStore } from './settings.js';
import { localTime, timeZoneOf } from './time.js';

/**
 * The Telegram side of the chat: commands with buttons for tasks and the calendar, and
 * everything else (typed or spoken) goes to the chat assistant. Only the chat that was
 * linked under Settings → Reminders is answered.
 */

export type TelegramApi = (token: string, method: string, body: object, signal?: AbortSignal) => Promise<unknown>;

export interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    /** `type` is "private" for a chat with one person, else "group", "supergroup" or "channel". */
    chat: { id: number; type?: string };
    /** Who wrote it (missing in channels). */
    from?: TelegramUser;
    text?: string;
    voice?: { file_id: string; duration: number; mime_type?: string };
  };
  callback_query?: { id: string; from: TelegramUser; data?: string; message?: { message_id: number; chat: { id: number } } };
}

export interface TelegramUser {
  id: number;
  username?: string;
  first_name?: string;
}

export interface BotChat {
  /** Answers a message with the chat assistant (Markdown); `onAction` hears each step it takes. */
  ask: (userId: string, text: string, onAction?: (action: ChatAction) => void) => Promise<string>;
  reset: (userId: string) => void;
  /** The user's answer to a step that waits for them; returns the step as it is now. */
  confirm?: (userId: string, actionId: string, yes: boolean) => ChatAction;
  /** Writes down a voice message; null without a transcription service. */
  transcribe?: (userId: string, audio: { bytes: Buffer; filename: string; mime: string }) => Promise<string | null>;
}

/** Commands shown in Telegram's menu. */
export const BOT_COMMANDS = [
  { command: 'todo', description: 'Open tasks, to tick off' },
  { command: 'calendar', description: 'This week' },
  { command: 'today', description: "Today's journal" },
  { command: 'new', description: 'Start a new conversation' },
  { command: 'help', description: 'What I can do' },
];

const HELP = [
  'Write to me like to a person, and I use your notes for you, for example:',
  '• <i>Remind me to call the dentist tomorrow at 9</i>',
  '• <i>Note in my journal that the heating was fixed</i>',
  '• <i>What did I write about the car?</i>',
  '• <i>Research heat pumps for old houses</i>',
  'Voice messages work too (with a transcription service set up in Nicotes).',
  '',
  '/todo – open tasks, tick them off with a tap',
  '/calendar – this week',
  '/today – today’s journal',
  '/new – forget our conversation and start over',
].join('\n');

const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const clip = (text: string, length: number) => (text.length > length ? `${text.slice(0, length - 1)}…` : text);

/**
 * Markdown as Telegram's HTML: bold, italics, code, links and lists; [[links]] open the page
 * in Nicotes when `link` knows it.
 */
export function telegramHtml(markdown: string, link: (target: string) => string | null): string {
  const blocks: string[] = [];
  const keep = (html: string) => `\u0000${blocks.push(html) - 1}\u0000`;
  let text = markdown.replace(/```[^\n]*\n([\s\S]*?)```/g, (_m, code: string) => keep(`<pre>${escape(code.replace(/\n$/, ''))}</pre>`));
  text = text.replace(/`([^`\n]+)`/g, (_m, code: string) => keep(`<code>${escape(code)}</code>`));
  text = escape(text)
    .replace(/\[\[([^\]|\n]+)(?:\|([^\]\n]+))?\]\]/g, (_m, target: string, label?: string) => {
      const href = link(target.trim());
      const shown = escape((label ?? target).trim());
      return href ? keep(`<a href="${escape(href)}">${shown}</a>`) : `<b>${shown}</b>`;
    })
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, (_m, label: string, href: string) => keep(`<a href="${href}">${label}</a>`))
    .replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
    .replace(/__([^_\n]+)__/g, '<b>$1</b>')
    .replace(/(^|[^\w*])\*([^*\n]+)\*(?!\w)/g, '$1<i>$2</i>')
    .replace(/(^|[^\w])_([^_\n]+)_(?!\w)/g, '$1<i>$2</i>')
    .replace(/^(\s*)[-*+] \[[xX]\] /gm, '$1☑ ')
    .replace(/^(\s*)[-*+] \[ \] /gm, '$1☐ ')
    .replace(/^(\s*)[-*+] /gm, '$1• ');
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => blocks[Number(i)]!);
}

const STEP_ICONS: [RegExp, string][] = [
  [/^search/, '🔎'],
  [/journal/, '📓'],
  [/task/, '☑️'],
  [/^calendar/, '📅'],
  [/research/, '🔭'],
  [/^(create|append)/, '📝'],
];

/**
 * What the assistant did in Nicotes, one line per tool call, folded into a quote that
 * Telegram shows collapsed when it is long. Pages it touched link to Nicotes.
 */
export function stepsHtml(actions: ChatAction[], pageUrl: (id: string) => string | null): string {
  const lines = actions.map((a) => {
    const icon = a.confirm?.state === 'pending' ? '❓' : a.ok ? (STEP_ICONS.find(([re]) => re.test(a.tool))?.[1] ?? '📄') : '⚠️';
    const href = a.pageId ? pageUrl(a.pageId) : null;
    const summary = escape(clip(a.summary, 120));
    return `${icon} ${href ? `<a href="${escape(href)}">${summary}</a>` : summary}`;
  });
  return `<blockquote expandable>${lines.join('\n')}</blockquote>`;
}

/** Telegram allows 4096 characters per message: long answers are split at paragraphs. */
export function splitMessage(html: string, max = 4000): string[] {
  const parts: string[] = [];
  let rest = html;
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n\n', max);
    if (cut < max / 2) cut = rest.lastIndexOf('\n', max);
    if (cut < max / 2) cut = max;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, '');
  }
  return [...parts, rest];
}

const addDays = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const dayLabel = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
const mondayOf = (date: string) => addDays(date, -((new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7));
/** Ties a button to the exact line, so a task that changed meanwhile is not ticked by mistake. */
const lineHash = (raw: string) => createHash('sha1').update(raw).digest('base64url').slice(0, 6);

type Keyboard = { text: string; callback_data: string }[][];

export class TelegramBot {
  constructor(
    private db: Db,
    private settings: SettingsStore,
    private telegram: TelegramApi,
    private now: () => number,
    /** The address links to pages start with, if known. */
    private appUrl: (userId: string) => string | null,
    public chat: BotChat | null = null,
  ) {}

  private today(userId: string) {
    return localTime(this.now(), timeZoneOf(this.settings, userId)).date;
  }

  private tasks(userId: string): PageTask[] {
    return listTasks(this.db, userId, 'open', this.settings.view(userId).tasks.excludeTags);
  }

  /** Open tasks: overdue, today, the next week, then undated ones; a button ticks each off. */
  todoView(userId: string): { text: string; keyboard: Keyboard } {
    const today = this.today(userId);
    const all = this.tasks(userId).sort((a, b) => (a.due ?? '9999').localeCompare(b.due ?? '9999'));
    const groups: [string, PageTask[]][] = [
      ['Overdue', all.filter((t) => t.due && t.due < today)],
      ['Today', all.filter((t) => t.due === today)],
      ['Next days', all.filter((t) => t.due && t.due > today && t.due <= addDays(today, 7))],
      ['No date', all.filter((t) => !t.due).slice(0, 8)],
    ];
    const shown = groups.flatMap(([, list]) => list).slice(0, 12);
    if (!shown.length) return { text: 'No open tasks. 🎉', keyboard: [] };
    const lines: string[] = [];
    for (const [label, list] of groups) {
      if (!list.length) continue;
      lines.push(`<b>${label}</b>`);
      for (const t of list) lines.push(`☐ ${escape(clip(taskPlainText(t.text), 120))}${t.due && label !== 'Today' ? ` <i>(${dayLabel(t.due)})</i>` : ''}`);
      lines.push('');
    }
    const keyboard = shown.map((t) => [{ text: `✓ ${clip(taskPlainText(t.text), 40)}`, callback_data: `d:${t.pageId}:${t.line}:${lineHash(t.raw)}` }]);
    return { text: `${lines.join('\n').trim()}\n\nTap a task when it is done.`, keyboard };
  }

  /** A week, Monday to Sunday: tasks due (and done) per day, with buttons to move on. */
  calendarView(userId: string, anyDay?: string): { text: string; keyboard: Keyboard } {
    const today = this.today(userId);
    const monday = mondayOf(anyDay ?? today);
    const sunday = addDays(monday, 6);
    const tasks = listTasks(this.db, userId, 'all', this.settings.view(userId).tasks.excludeTags).filter(
      (t) => (t.due && t.due >= monday && t.due <= sunday) || (!t.due && t.remind && t.remind.slice(0, 10) >= monday && t.remind.slice(0, 10) <= sunday),
    );
    const lines = [`<b>Week of ${dayLabel(monday)}</b>`, ''];
    for (let day = monday; day <= sunday; day = addDays(day, 1)) {
      const due = tasks.filter((t) => (t.due ?? t.remind?.slice(0, 10)) === day);
      lines.push(`${day === today ? '▸ ' : ''}<b>${dayLabel(day)}</b>`);
      if (!due.length) lines.push('<i>–</i>');
      for (const t of due) {
        const time = t.remind?.startsWith(day) ? ` ⏰ ${t.remind.slice(11)}` : '';
        lines.push(`${t.done ? '☑' : '☐'} ${t.done ? `<s>${escape(clip(taskPlainText(t.text), 100))}</s>` : escape(clip(taskPlainText(t.text), 100))}${time}`);
      }
    }
    const keyboard: Keyboard = [
      [
        { text: '« Week before', callback_data: `w:${addDays(monday, -7)}` },
        { text: 'This week', callback_data: `w:${mondayOf(today)}` },
        { text: 'Next week »', callback_data: `w:${addDays(monday, 7)}` },
      ],
    ];
    return { text: lines.join('\n'), keyboard };
  }

  /** A [[link]] as an address in Nicotes, when its page exists and the app's address is known. */
  private linker(userId: string) {
    const appUrl = this.appUrl(userId);
    if (!appUrl) return () => null;
    const ctx = loadLinkContext(this.db, userId);
    return (target: string) => {
      const page = resolveWikilink(ctx, target);
      return page ? `${appUrl}/p/${page.id}` : null;
    };
  }

  private pageUrl(userId: string) {
    const appUrl = this.appUrl(userId);
    return (id: string) => (appUrl ? `${appUrl}/p/${id}` : null);
  }

  private send(token: string, chatId: number, html: string, keyboard?: Keyboard) {
    return this.telegram(token, 'sendMessage', {
      chat_id: chatId,
      text: html,
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      ...(keyboard?.length ? { reply_markup: { inline_keyboard: keyboard } } : {}),
    });
  }

  /** An update from the user's linked chat. */
  async handle(token: string, userId: string, update: TelegramUpdate) {
    if (update.callback_query) return this.button(token, userId, update.callback_query);
    const message = update.message;
    if (!message) return;
    const chatId = message.chat.id;
    let text = message.text?.trim() ?? '';
    if (message.voice) {
      const heard = await this.listen(token, userId, message.voice);
      if (heard === null) return this.send(token, chatId, 'Voice messages need a transcription service: set one up in Nicotes under Settings → Voice notes.');
      if (!heard) return this.send(token, chatId, 'I could not make out any words in that.');
      await this.send(token, chatId, `🎙️ <i>${escape(clip(heard, 500))}</i>`);
      text = heard;
    }
    if (!text) return;
    const command = /^\/(\w+)(?:@\w+)?(?:\s+([\s\S]*))?$/.exec(text);
    switch (command?.[1]?.toLowerCase()) {
      case 'start':
      case 'help':
        return this.send(token, chatId, HELP);
      case 'todo':
      case 'tasks': {
        const view = this.todoView(userId);
        return this.send(token, chatId, view.text, view.keyboard);
      }
      case 'calendar':
      case 'week': {
        const view = this.calendarView(userId);
        return this.send(token, chatId, view.text, view.keyboard);
      }
      case 'today':
      case 'journal':
        text = 'Show me today’s journal entry and what is due today.';
        break;
      case 'new':
      case 'reset':
        this.chat?.reset(userId);
        return this.send(token, chatId, 'Started a new conversation; I forgot what we talked about.');
      default:
        if (command) return this.send(token, chatId, `I don’t know /${escape(command[1]!)}.\n\n${HELP}`);
    }
    if (!this.chat) return;
    // Answers can take a while: show "typing…" until it is there.
    const showTyping = () => void this.telegram(token, 'sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
    const typing = setInterval(showTyping, 4500);
    showTyping();
    // The steps the assistant takes, in one message that grows as they happen. Updates are
    // sent one at a time; steps that came in meanwhile go out together.
    const actions: ChatAction[] = [];
    const pageUrl = this.pageUrl(userId);
    let stepsId: number | null = null;
    let shown = 0;
    let updates = Promise.resolve();
    const onAction = (action: ChatAction) => {
      actions.push(action);
      updates = updates
        .then(async () => {
          if (shown === actions.length) return;
          shown = actions.length;
          const html = stepsHtml(actions, pageUrl);
          if (stepsId === null) {
            stepsId = ((await this.send(token, chatId, html)) as { message_id: number }).message_id;
            showTyping(); // a new message ends "typing…"
          } else {
            await this.telegram(token, 'editMessageText', { chat_id: chatId, message_id: stepsId, text: html, parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
          }
        })
        .catch(() => {});
    };
    try {
      const answer = await this.chat.ask(userId, text, onAction);
      await updates;
      for (const part of splitMessage(telegramHtml(answer, this.linker(userId)))) await this.send(token, chatId, part);
      // Steps that wait for the user (such as deleting a page) get buttons of their own.
      for (const { summary, confirm } of actions) {
        if (confirm?.state !== 'pending') continue;
        await this.send(token, chatId, escape(summary), [
          [
            { text: `✓ ${confirm.yes}`, callback_data: `c:${confirm.id}:1` },
            { text: confirm.no, callback_data: `c:${confirm.id}:0` },
          ],
        ]);
      }
    } catch (err) {
      await this.send(token, chatId, `Sorry, that did not work: ${escape((err as Error).message)}`);
    } finally {
      clearInterval(typing);
    }
  }

  private async listen(token: string, userId: string, voice: NonNullable<NonNullable<TelegramUpdate['message']>['voice']>): Promise<string | null> {
    if (!this.chat?.transcribe) return null;
    const file = (await this.telegram(token, 'getFile', { file_id: voice.file_id })) as { file_path?: string };
    if (!file.file_path) throw new Error('Telegram did not hand out the voice message');
    const res = await fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`Telegram answered ${res.status} for the voice message`);
    const bytes = Buffer.from(await res.arrayBuffer());
    return this.chat.transcribe(userId, { bytes, filename: 'voice.ogg', mime: voice.mime_type ?? 'audio/ogg' });
  }

  private async button(token: string, userId: string, query: NonNullable<TelegramUpdate['callback_query']>) {
    const message = query.message;
    const answer = (text?: string) => this.telegram(token, 'answerCallbackQuery', { callback_query_id: query.id, ...(text ? { text } : {}) }).catch(() => {});
    const edit = (view: { text: string; keyboard: Keyboard }) =>
      message
        ? this.telegram(token, 'editMessageText', {
            chat_id: message.chat.id,
            message_id: message.message_id,
            text: view.text,
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: view.keyboard },
          }).catch(() => {})
        : Promise.resolve();
    const data = query.data ?? '';
    const week = /^w:(\d{4}-\d{2}-\d{2})$/.exec(data);
    if (week) {
      await answer();
      return edit(this.calendarView(userId, week[1]));
    }
    const confirm = /^c:([\w-]+):([01])$/.exec(data);
    if (confirm && this.chat?.confirm) {
      try {
        const action = this.chat.confirm(userId, confirm[1]!, confirm[2] === '1');
        await answer();
        return edit({ text: escape(action.summary), keyboard: [] });
      } catch (err) {
        await answer((err as Error).message);
        return edit({ text: escape((err as Error).message), keyboard: [] });
      }
    }
    const done = /^d:([\w-]+):(\d+):([\w-]+)$/.exec(data);
    if (done) {
      const [, pageId, line, hash] = done;
      const task = this.tasks(userId).find((t) => t.pageId === pageId && t.line === Number(line));
      if (!task || lineHash(task.raw) !== hash) {
        await answer('That task changed or is already done.');
      } else {
        updateTask(this.db, userId, { pageId: pageId!, line: task.line, raw: task.raw, done: true }, this.today(userId));
        await answer(`Done: ${clip(taskPlainText(task.text), 60)}`);
      }
      return edit(this.todoView(userId));
    }
    await answer();
  }
}
