import { createHash } from 'node:crypto';
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
import { answerConfirmation, notesOverview, runTool, toolByName, toolSpecs, type ToolContext } from './tools.js';

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
 * An earlier message as the model sees it again. An answer comes with its steps as the tool
 * calls and results they were (results cut to what was done): with the text alone, earlier
 * answers saying "I added it" look like the way to answer, and a model repeats them without
 * calling anything.
 */
function replay(entry: ChatEntry): ToolMessage[] {
  if (entry.role === 'user') return [{ role: 'user', content: entry.content }];
  const steps = entry.actions.filter((a) => toolByName.has(a.tool));
  if (!steps.length) return [{ role: 'assistant', content: entry.content }];
  // Some providers only take ids of 9 letters and digits.
  const id = (i: number) => createHash('sha1').update(`${entry.id}:${i}`).digest('hex').slice(0, 9);
  return [
    { role: 'assistant', content: null, tool_calls: steps.map((a, i) => ({ id: id(i), type: 'function', function: { name: a.tool, arguments: a.args ?? '{}' } })) },
    ...steps.map((a, i): ToolMessage => {
      const result = a.confirm?.state === 'pending' ? { waiting_for_user: a.summary } : a.ok ? { done: a.summary } : { error: a.summary };
      return { role: 'tool', tool_call_id: id(i), content: JSON.stringify(result) };
    }),
    { role: 'assistant', content: entry.content },
  ];
}

const sizeOf = (messages: ToolMessage[]) =>
  messages.reduce((sum, m) => sum + (m.content?.length ?? 0) + ('tool_calls' in m ? JSON.stringify(m.tool_calls).length : 0), 0);

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

function systemPrompt(username: string, now: number, timeZone: string, channel: ChatChannel, notes: string): string {
  const { date, time } = localTime(now, timeZone);
  const weekday = new Date(`${date}T12:00:00Z`).toLocaleDateString('en', { weekday: 'long', timeZone: 'UTC' });
  return [
    `You are the assistant inside Nicotes, the personal notes app of ${username}. You act in the app for them with the tools: search and read their notes, write pages and the journal, manage tasks, show the calendar, start web research.`,
    `Now: ${weekday}, ${date}, ${time} (${timeZone}). Work out dates like "tomorrow" or "next Friday" from this.`,
    `Their notes right now: ${notes} Use list_pages for the pages in them, list_journal for the journal's days.`,
    'Rules:',
    '- Look things up with the tools instead of guessing or answering from earlier messages; never invent notes, notebooks, tasks or dates. Say so when nothing was found.',
    '- Every answer starts with at least one tool call: for a request the call that does it, for a question the lookup that answers it.',
    '- Questions about Nicotes itself (how a feature works, where a setting is, what it can do): look it up with nicotes_help and answer from that guide; never guess menu names or features.',
    '- Notes the user asks you to keep go into today\'s journal unless they name a page. Tasks go into today\'s journal unless they name a page.',
    '- Only a tool changes anything. Never say you added, created, changed, moved or deleted something unless a tool call in your current answer did it and succeeded; if you made none, nothing was changed.',
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
    const messages = replay(toEntry(row));
    size += sizeOf(messages);
    if (size > HISTORY_CHARS) break;
    history.unshift(...messages);
  }
  // The history starts with a question, not with an answer cut off from it.
  while (history[0] && history[0].role !== 'user') history.shift();
  opts.onUser?.(save(db, opts.userId, opts.channel, 'user', opts.text));

  const now = opts.now ?? Date.now();
  const timeZone = timeZoneOf(settings, opts.userId);
  const ctx: ToolContext = { ...deps, userId: opts.userId, today: localTime(now, timeZone).date };
  const messages: ToolMessage[] = [
    { role: 'system', content: systemPrompt(opts.username, now, timeZone, opts.channel, notesOverview(ctx)) },
    ...history,
    { role: 'user', content: opts.text },
  ];
  const tools = toolSpecs();
  const actions: ChatAction[] = [];
  let usage = emptyUsage();
  let answer = '';
  for (let round = 0; ; round++) {
    // The first round has to call a tool, so an answer rests on a lookup or an action rather
    // than on earlier messages; in the last round the model has to answer with what it found.
    const last = round >= MAX_ROUNDS || usage.cost >= cfg.costLimit;
    const toolChoice = last ? 'none' : round === 0 ? 'required' : 'auto';
    const reply = await chatWithTools({ keys: cfg.keys, model, messages, tools, toolChoice, maxTokens: 3000, signal: opts.signal });
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
