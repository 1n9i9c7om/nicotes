import { and, asc, desc, eq } from 'drizzle-orm';
import type { ChatAction, ChatChannel, ChatEntry } from '@nicotes/shared';
import type { JobRunner } from '../ai/jobs.js';
import { addUsage, chatWithTools, emptyUsage, hasKeyFor, LlmError, missingKeyMessage, type ToolMessage } from '../ai/llm.js';
import type { SemanticIndex } from '../ai/semantic.js';
import type { Db } from '../db/index.js';
import { chatMessages } from '../db/schema.js';
import { newId } from '../ids.js';
import { localTime, timeZoneOf } from '../time.js';
import type { SettingsStore } from '../settings.js';
import { runTool, toolSpecs, type ToolContext } from './tools.js';

/** Tool rounds per message: enough to search, read and then write. */
const MAX_ROUNDS = 8;
/** Earlier messages the model sees, newest first, up to this many characters. */
const HISTORY_CHARS = 24_000;

export interface ChatDeps {
  db: Db;
  settings: SettingsStore;
  jobs: JobRunner;
  semantic: SemanticIndex;
}

const toEntry = (row: typeof chatMessages.$inferSelect): ChatEntry => ({
  id: row.id,
  role: row.role as ChatEntry['role'],
  content: row.content,
  actions: row.actions ? (JSON.parse(row.actions) as ChatAction[]) : [],
  createdAt: row.createdAt,
});

export function chatHistory(db: Db, userId: string, channel: ChatChannel): ChatEntry[] {
  return db
    .select()
    .from(chatMessages)
    .where(and(eq(chatMessages.userId, userId), eq(chatMessages.channel, channel)))
    .orderBy(asc(chatMessages.createdAt))
    .all()
    .map(toEntry);
}

/** Forgets a conversation: the next message starts without any context. */
export function resetChat(db: Db, userId: string, channel: ChatChannel) {
  db.delete(chatMessages).where(and(eq(chatMessages.userId, userId), eq(chatMessages.channel, channel))).run();
}

function save(db: Db, userId: string, channel: ChatChannel, role: ChatEntry['role'], content: string, actions: ChatAction[] = []): ChatEntry {
  const row = { id: newId(), userId, channel, role, content, actions: actions.length ? JSON.stringify(actions) : null, createdAt: Date.now() };
  db.insert(chatMessages).values(row).run();
  return toEntry(row);
}

function systemPrompt(username: string, now: number, timeZone: string, channel: ChatChannel): string {
  const { date, time } = localTime(now, timeZone);
  const weekday = new Date(`${date}T12:00:00Z`).toLocaleDateString('en', { weekday: 'long', timeZone: 'UTC' });
  return [
    `You are the assistant inside Nicotes, the personal notes app of ${username}. You act in the app for them with the tools: search and read their notes, write pages and the journal, manage tasks, show the calendar, start web research.`,
    `Now: ${weekday}, ${date}, ${time} (${timeZone}). Work out dates like "tomorrow" or "next Friday" from this.`,
    'Rules:',
    '- Look things up with the tools instead of guessing; never invent notes, tasks or dates. Say so when nothing was found.',
    '- Notes the user asks you to keep go into today\'s journal unless they name a page. Tasks go into today\'s journal unless they name a page.',
    '- Before changing or ticking off a task, find it with list_tasks. Do not delete or rewrite existing text; only add to it.',
    '- Mention pages as [[Title]] so they can be opened. Pages are Markdown; tasks are lines like "- [ ] text 📅 YYYY-MM-DD ⏰ HH:MM".',
    '- For a calendar or a task overview, give a compact list grouped by day (weekday and date), today first.',
    '- Answer in the language the user writes in. Be brief and friendly; no preamble about what you are going to do.',
    channel === 'telegram' ? '- Your answer is shown in Telegram: keep it short, use only **bold**, *italics*, `code`, lists and links.' : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Answers one message: the model may call tools (in up to MAX_ROUNDS rounds) before it
 * writes its answer. Both the message and the answer, with what was done, are saved.
 */
export async function runChat(
  deps: ChatDeps,
  opts: {
    userId: string;
    username: string;
    channel: ChatChannel;
    text: string;
    onUser?: (entry: ChatEntry) => void;
    onAction?: (action: ChatAction) => void;
    signal?: AbortSignal;
    now?: number;
  },
): Promise<ChatEntry> {
  const { db, settings } = deps;
  const cfg = settings.effective(opts.userId);
  const model = cfg.models.ask;
  if (!hasKeyFor(cfg.keys, model)) throw new LlmError(missingKeyMessage('The chat', model));

  // The conversation so far, newest last, within HISTORY_CHARS.
  const earlier = db
    .select()
    .from(chatMessages)
    .where(and(eq(chatMessages.userId, opts.userId), eq(chatMessages.channel, opts.channel)))
    .orderBy(desc(chatMessages.createdAt))
    .limit(60)
    .all();
  const history: ToolMessage[] = [];
  let size = 0;
  for (const row of earlier) {
    size += row.content.length;
    if (size > HISTORY_CHARS) break;
    history.unshift({ role: row.role as 'user' | 'assistant', content: row.content });
  }
  opts.onUser?.(save(db, opts.userId, opts.channel, 'user', opts.text));

  const now = opts.now ?? Date.now();
  const timeZone = timeZoneOf(settings, opts.userId);
  const ctx: ToolContext = { ...deps, userId: opts.userId, today: localTime(now, timeZone).date };
  const messages: ToolMessage[] = [
    { role: 'system', content: systemPrompt(opts.username, now, timeZone, opts.channel) },
    ...history,
    { role: 'user', content: opts.text },
  ];
  const tools = toolSpecs();
  const actions: ChatAction[] = [];
  let usage = emptyUsage();
  let answer = '';
  for (let round = 0; ; round++) {
    // In the last round the model has to answer with what it found.
    const last = round >= MAX_ROUNDS || usage.cost >= cfg.costLimit;
    const reply = await chatWithTools({ keys: cfg.keys, model, messages, tools, toolChoice: last ? 'none' : 'auto', maxTokens: 3000, signal: opts.signal });
    usage = addUsage(usage, reply.usage);
    if (!reply.toolCalls.length || last) {
      answer = reply.content.trim();
      break;
    }
    messages.push({
      role: 'assistant',
      content: reply.content || null,
      tool_calls: reply.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } })),
    });
    for (const call of reply.toolCalls) {
      const { result, action } = await runTool(ctx, call.name, call.arguments);
      actions.push(action);
      opts.onAction?.(action);
      messages.push({ role: 'tool', tool_call_id: call.id, content: result.slice(0, 20_000) });
    }
  }
  return save(db, opts.userId, opts.channel, 'assistant', answer || 'Done.', actions);
}
