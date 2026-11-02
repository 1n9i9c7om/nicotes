import { and, asc, desc, eq, like } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import type { ChatAction, ChatChannel, ChatEntry } from '@nicotes/shared';
import type { JobRunner } from '../ai/jobs.js';
import { addUsage, chatWithTools, emptyUsage, hasKeyFor, LlmError, missingKeyMessage, type ToolMessage } from '../ai/llm.js';
import type { SemanticIndex } from '../ai/semantic.js';
import type { Db } from '../db/index.js';
import { chatMessages } from '../db/schema.js';
import { newId } from '../ids.js';
import { localTime, timeZoneOf } from '../time.js';
import type { SettingsStore } from '../settings.js';
import { answerConfirmation, runTool, toolSpecs, type ToolContext } from './tools.js';

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

/**
 * Earlier answers reach the model with what was done for them, so it neither repeats a claim
 * without the work nor forgets what it did.
 */
const STEPS_PREFIX = '[Steps in Nicotes:';

function withSteps(content: string, actions: ChatAction[]): string {
  const steps = actions.map((a) => `${a.summary}${a.confirm?.state === 'pending' ? ' (waiting for the user)' : a.ok ? '' : ' (failed)'}`);
  return `${STEPS_PREFIX} ${steps.join('; ') || 'none'}]\n${content}`;
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

/**
 * The user's answer to a step that waited for them (such as deleting a page): carries it out
 * or drops it, and returns the chat entry it belongs to with the step updated.
 */
export function confirmAction(db: Db, userId: string, actionId: string, yes: boolean): ChatEntry {
  if (/^[\w-]{1,64}$/.test(actionId)) {
    const rows = db
      .select()
      .from(chatMessages)
      .where(and(eq(chatMessages.userId, userId), like(chatMessages.actions, `%"id":"${actionId}"%`)))
      .all();
    for (const row of rows) {
      const actions = JSON.parse(row.actions!) as ChatAction[];
      const action = actions.find((a) => a.confirm?.id === actionId);
      if (!action?.confirm) continue;
      if (action.confirm.state !== 'pending') throw new HTTPException(409, { message: 'That was already answered' });
      action.summary = answerConfirmation(db, userId, action, yes);
      action.confirm.state = yes ? 'done' : 'declined';
      const updated = { ...row, actions: JSON.stringify(actions) };
      db.update(chatMessages).set({ actions: updated.actions }).where(eq(chatMessages.id, row.id)).run();
      return toEntry(updated);
    }
  }
  throw new HTTPException(404, { message: 'That question is gone (the chat may have been started anew)' });
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
    '- Only a tool changes anything. Never say you added, created, changed, moved or deleted something unless a tool call in your current answer did it and succeeded; if you made none, nothing was changed.',
    `- Each of your earlier answers starts with "${STEPS_PREFIX} …]": what was really done for it. Never write such a line yourself.`,
    '- Pages change in between (the user edits and moves them in the app): read a page again instead of relying on earlier answers. Say where a page is with its path (Notebook › Parent › Page).',
    '- Before changing or ticking off a task, find it with list_tasks. Do not delete or rewrite existing text; only add to it.',
    '- To delete a page, use delete_page: the user then confirms with a button, so tell them it waits for that.',
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
    const entry = toEntry(row);
    const content = entry.role === 'assistant' ? withSteps(entry.content, entry.actions) : entry.content;
    size += content.length;
    if (size > HISTORY_CHARS) break;
    history.unshift({ role: entry.role, content });
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
      // A model may imitate the steps line of earlier answers.
      answer = reply.content.trim().replace(/^\[Steps in Nicotes:[^\]\n]*\]\s*/, '');
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
