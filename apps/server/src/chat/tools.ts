import { and, asc, count, eq, gte, isNull, lte } from 'drizzle-orm';
import { z } from 'zod';
import {
  appendBlock,
  dateSchema,
  isCanvas,
  MATCH_END,
  MATCH_START,
  parseRecurRule,
  resolveWikilink,
  taskPlainText,
  type ChatAction,
  type Page,
} from '@nicotes/shared';
import type { JobRunner } from '../ai/jobs.js';
import type { SemanticIndex } from '../ai/semantic.js';
import type { Db } from '../db/index.js';
import { dailyNotes, notebooks, pages } from '../db/schema.js';
import { newId } from '../ids.js';
import { loadLinkContext } from '../links.js';
import { ensureDailyNote } from '../routes/daily.js';
import { createPage, findPage } from '../routes/pages.js';
import { searchPages } from '../routes/search.js';
import { addTask, listTasks, saveContent, updateTask } from '../routes/tasks.js';
import type { SettingsStore } from '../settings.js';

/** What every tool works with: the account, and "today" in its time zone. */
export interface ToolContext {
  db: Db;
  settings: SettingsStore;
  jobs: JobRunner;
  semantic: SemanticIndex;
  userId: string;
  /** YYYY-MM-DD in the account's time zone. */
  today: string;
}

interface ToolResult {
  /** Sent back to the model as JSON. */
  data: unknown;
  /** Shown to the user: what was done. */
  summary: string;
  pageId?: string;
}

interface Tool<S extends z.ZodObject = z.ZodObject> {
  name: string;
  description: string;
  schema: S;
  run: (ctx: ToolContext, args: z.infer<S>) => ToolResult | Promise<ToolResult>;
}

const tool = <S extends z.ZodObject>(t: Tool<S>) => t as unknown as Tool;

/** Page text the model reads at most; longer pages are cut. */
const MAX_PAGE_CHARS = 12_000;

const plainExcerpt = (text: string) => text.split(MATCH_START).join('').split(MATCH_END).join('').replace(/\s+/g, ' ').trim();

function notebookByName(ctx: ToolContext, name: string) {
  const all = ctx.db
    .select({ id: notebooks.id, title: notebooks.title })
    .from(notebooks)
    .where(and(eq(notebooks.userId, ctx.userId), isNull(notebooks.deletedAt)))
    .all();
  const found = all.find((n) => n.id === name) ?? all.find((n) => n.title.toLowerCase() === name.trim().toLowerCase());
  if (!found) throw new Error(`There is no notebook "${name}". Notebooks: ${all.map((n) => n.title).join(', ') || 'none'}`);
  return found;
}

/** A page by id, or by title like a [[link]] ("Title" or "Notebook/Title"). */
function pageByName(ctx: ToolContext, name: string): Page {
  const byId = ctx.db.select({ id: pages.id }).from(pages).where(and(eq(pages.id, name), eq(pages.userId, ctx.userId), isNull(pages.deletedAt))).get();
  if (byId) return findPage(ctx.db, ctx.userId, byId.id);
  const found = resolveWikilink(loadLinkContext(ctx.db, ctx.userId), name.replace(/^\[\[|\]\]$/g, ''));
  if (!found) throw new Error(`There is no page "${name}"; search for it first`);
  return findPage(ctx.db, ctx.userId, found.id);
}

/** What a model should read of a page: canvas pages only have their texts. */
function readable(page: Page): string {
  const content = isCanvas(page.content)
    ? (/## Text Elements\s*\n([\s\S]*?)(?=\n## |\n%%|$)/.exec(page.content)?.[1] ?? '').replace(/ \^[\w-]+$/gm, '').trim()
    : page.content;
  return content.length > MAX_PAGE_CHARS ? `${content.slice(0, MAX_PAGE_CHARS)}\n\n[… cut, ${content.length} characters in all]` : content;
}

function addDays(date: string, days: number) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

function journalPageId(ctx: ToolContext, date: string): string | null {
  const row = ctx.db
    .select({ pageId: dailyNotes.pageId })
    .from(dailyNotes)
    .innerJoin(pages, eq(pages.id, dailyNotes.pageId))
    .where(and(eq(dailyNotes.userId, ctx.userId), eq(dailyNotes.date, date), isNull(pages.deletedAt)))
    .get();
  return row?.pageId ?? null;
}

const taskRef = (t: { pageId: string; line: number }) => `${t.pageId}:${t.line}`;

function openTasks(ctx: ToolContext, status: 'open' | 'done' | 'all' = 'open') {
  return listTasks(ctx.db, ctx.userId, status, ctx.settings.view(ctx.userId).tasks.excludeTags);
}

const quoted = (text: string, max = 60) => `“${text.length > max ? `${text.slice(0, max - 1)}…` : text}”`;

export const TOOLS: Tool[] = [
  tool({
    name: 'search_notes',
    description: 'Full-text search over all pages (and PDFs and other files they show). Use short keyword queries; "#tag" filters by tag.',
    schema: z.object({ query: z.string().min(1).max(200), limit: z.number().int().min(1).max(20).optional() }),
    run(ctx, { query, limit }) {
      const hits = searchPages(ctx.db, ctx.userId, query, limit ?? 8);
      return {
        data: hits.map((h) => ({ id: h.id, title: h.title, excerpt: plainExcerpt(h.excerpt), file: h.attachment?.filename })),
        summary: `Searched for ${quoted(query)} (${hits.length} found)`,
      };
    },
  }),
  tool({
    name: 'search_by_meaning',
    description: 'Finds pages about a topic even without matching words (needs the semantic index; falls back to telling you it is off).',
    schema: z.object({ query: z.string().min(1).max(500) }),
    async run(ctx, { query }) {
      const found = await ctx.semantic.search(ctx.userId, query, 8);
      if (!found.enabled) return { data: { error: 'The semantic index is off; use search_notes instead.' }, summary: 'Searched by meaning (index is off)' };
      return {
        data: found.results.map((r) => ({ id: r.id, title: r.title, heading: r.heading, excerpt: r.excerpt })),
        summary: `Searched by meaning for ${quoted(query)}`,
      };
    },
  }),
  tool({
    name: 'read_page',
    description: 'Reads a page: its Markdown, notebook, tags, subpages and when it changed. Accepts a page id or a title.',
    schema: z.object({ page: z.string().min(1).max(300) }),
    run(ctx, { page: name }) {
      const page = pageByName(ctx, name);
      const subpages = ctx.db
        .select({ title: pages.title })
        .from(pages)
        .where(and(eq(pages.parentId, page.id), isNull(pages.deletedAt)))
        .orderBy(asc(pages.sortOrder))
        .all()
        .map((p) => p.title);
      const notebook = ctx.db.select({ title: notebooks.title }).from(notebooks).where(eq(notebooks.id, page.notebookId)).get();
      return {
        data: {
          id: page.id,
          title: page.title,
          notebook: notebook?.title,
          tags: page.tags,
          kind: isCanvas(page.content) ? 'canvas (a drawing; only its texts are shown)' : 'page',
          updated: new Date(page.updatedAt).toISOString(),
          subpages,
          content: readable(page),
        },
        summary: `Read ${quoted(page.title || 'Untitled')}`,
        pageId: page.id,
      };
    },
  }),
  tool({
    name: 'list_notebooks',
    description: 'Lists the notebooks with how many pages each has.',
    schema: z.object({}),
    run(ctx) {
      const rows = ctx.db
        .select({ id: notebooks.id, title: notebooks.title, pages: count(pages.id) })
        .from(notebooks)
        .leftJoin(pages, and(eq(pages.notebookId, notebooks.id), isNull(pages.deletedAt)))
        .where(and(eq(notebooks.userId, ctx.userId), isNull(notebooks.deletedAt)))
        .groupBy(notebooks.id)
        .orderBy(asc(notebooks.sortOrder))
        .all();
      return { data: rows, summary: 'Looked at the notebooks' };
    },
  }),
  tool({
    name: 'list_pages',
    description: 'Lists the pages of a notebook (by title or id) as a tree.',
    schema: z.object({ notebook: z.string().min(1).max(200) }),
    run(ctx, { notebook: name }) {
      const nb = notebookByName(ctx, name);
      const rows = ctx.db
        .select({ id: pages.id, title: pages.title, parentId: pages.parentId })
        .from(pages)
        .where(and(eq(pages.notebookId, nb.id), isNull(pages.deletedAt)))
        .orderBy(asc(pages.sortOrder))
        .limit(300)
        .all();
      return { data: rows, summary: `Looked at the pages of ${quoted(nb.title)}` };
    },
  }),
  tool({
    name: 'create_page',
    description: 'Creates a page with Markdown content in a notebook, optionally below a parent page. Link other pages as [[Title]].',
    schema: z.object({
      notebook: z.string().min(1).max(200),
      title: z.string().min(1).max(300),
      content: z.string().max(200_000),
      parent: z.string().max(300).optional(),
    }),
    run(ctx, { notebook: name, title, content, parent }) {
      const nb = notebookByName(ctx, name);
      const parentPage = parent ? pageByName(ctx, parent) : null;
      if (parentPage && parentPage.notebookId !== nb.id) throw new Error('The parent page is in another notebook');
      const page = createPage(ctx.db, ctx.userId, { notebookId: nb.id, parentId: parentPage?.id ?? null, title, content });
      return { data: { id: page.id, title: page.title }, summary: `Created the page ${quoted(title)}`, pageId: page.id };
    },
  }),
  tool({
    name: 'append_to_page',
    description: 'Adds Markdown at the end of an existing page (keeps what is there).',
    schema: z.object({ page: z.string().min(1).max(300), text: z.string().min(1).max(50_000) }),
    run(ctx, { page: name, text }) {
      const page = pageByName(ctx, name);
      if (isCanvas(page.content)) throw new Error('This is a canvas (a drawing); text cannot be added to it');
      ctx.db.transaction((tx) => saveContent(tx, ctx.userId, page, appendBlock(page.content, text.trim())));
      return { data: { ok: true }, summary: `Added to ${quoted(page.title || 'Untitled')}`, pageId: page.id };
    },
  }),
  tool({
    name: 'read_journal',
    description: 'Reads the journal (daily note) of a day; today if no date is given.',
    schema: z.object({ date: dateSchema.optional() }),
    run(ctx, { date }) {
      const day = date ?? ctx.today;
      const id = journalPageId(ctx, day);
      if (!id) return { data: { date: day, exists: false }, summary: `Looked at the journal of ${day} (empty)` };
      const page = findPage(ctx.db, ctx.userId, id);
      return { data: { date: day, id, content: readable(page) }, summary: `Read the journal of ${day}`, pageId: id };
    },
  }),
  tool({
    name: 'write_journal',
    description: 'Writes Markdown into the journal (daily note) of a day, today if no date is given; the note is created if needed.',
    schema: z.object({ text: z.string().min(1).max(50_000), date: dateSchema.optional() }),
    run(ctx, { text, date }) {
      const day = date ?? ctx.today;
      const { pageId } = ensureDailyNote(ctx.db, ctx.settings, ctx.userId, day);
      const page = findPage(ctx.db, ctx.userId, pageId);
      ctx.db.transaction((tx) => saveContent(tx, ctx.userId, page, appendBlock(page.content, text.trim())));
      return { data: { ok: true, date: day }, summary: `Wrote in the journal of ${day}`, pageId };
    },
  }),
  tool({
    name: 'list_tasks',
    description:
      'Lists tasks (checkboxes) from all pages: open by default. Filter by due dates (YYYY-MM-DD, inclusive) or words. Each has a "ref" for update_task.',
    schema: z.object({
      status: z.enum(['open', 'done', 'all']).optional(),
      due_from: dateSchema.optional(),
      due_to: dateSchema.optional(),
      overdue: z.boolean().optional(),
      query: z.string().max(200).optional(),
      limit: z.number().int().min(1).max(200).optional(),
    }),
    run(ctx, { status, due_from, due_to, overdue, query, limit }) {
      const needle = query?.toLowerCase();
      const tasks = openTasks(ctx, status ?? 'open').filter(
        (t) =>
          (!due_from || (t.due && t.due >= due_from)) &&
          (!due_to || (t.due && t.due <= due_to)) &&
          (!overdue || (t.due && t.due < ctx.today && !t.done)) &&
          (!needle || `${t.text} ${t.pageTitle}`.toLowerCase().includes(needle)),
      );
      tasks.sort((a, b) => (a.due ?? '9999').localeCompare(b.due ?? '9999'));
      const shown = tasks.slice(0, limit ?? 60);
      return {
        data: {
          total: tasks.length,
          tasks: shown.map((t) => ({ ref: taskRef(t), text: taskPlainText(t.text), done: t.done, due: t.due, remind: t.remind, page: t.pageTitle })),
        },
        summary: `Looked at the tasks (${tasks.length})`,
      };
    },
  }),
  tool({
    name: 'add_task',
    description:
      'Adds a task. It goes into today\'s journal unless a page is given. Optional due date and a reminder time (HH:MM) on that day, or a reminder date and time. For repeating tasks give `repeat`, e.g. "every week", "every monday, thursday", "every month on the 1st", "every 2 weeks when done"; ticking one off then adds the next.',
    schema: z.object({
      text: z.string().min(1).max(1000),
      due: dateSchema.optional(),
      remind_at: z
        .string()
        .regex(/^(\d{4}-\d{2}-\d{2} )?([01]\d|2[0-3]):[0-5]\d$/, 'HH:MM or YYYY-MM-DD HH:MM')
        .optional(),
      page: z.string().max(300).optional(),
      repeat: z
        .string()
        .max(100)
        .refine((r) => parseRecurRule(r) !== null, 'A rule like "every week", "every monday" or "every month on the 1st"')
        .optional(),
    }),
    run(ctx, { text, due, remind_at, page: name, repeat }) {
      const pageId = name ? pageByName(ctx, name).id : ensureDailyNote(ctx.db, ctx.settings, ctx.userId, ctx.today).pageId;
      // A time alone needs a day to belong to.
      const remind = remind_at ? (remind_at.length === 5 && !due ? `${ctx.today} ${remind_at}` : remind_at) : null;
      const line = `${text.replace(/\s*\n\s*/g, ' ').trim()}${repeat ? ` 🔁 ${repeat.trim()}` : ''}${remind ? ` ⏰ ${remind}` : ''}`;
      addTask(ctx.db, ctx.userId, pageId, line, due ?? null);
      return { data: { ok: true }, summary: `Added the task ${quoted(text)}${due ? ` (due ${due})` : ''}`, pageId };
    },
  }),
  tool({
    name: 'update_task',
    description: 'Ticks a task off, reopens it, or changes its due date (null removes it). Takes the "ref" from list_tasks.',
    schema: z.object({ ref: z.string().min(3).max(100), done: z.boolean().optional(), due: dateSchema.nullable().optional() }),
    run(ctx, { ref, done, due }) {
      const [pageId, line] = [ref.slice(0, ref.lastIndexOf(':')), Number(ref.slice(ref.lastIndexOf(':') + 1))];
      const task = openTasks(ctx, 'all').find((t) => t.pageId === pageId && t.line === line);
      if (!task) throw new Error('That task is gone or moved; list the tasks again');
      if (done === undefined && due === undefined) throw new Error('Nothing to change');
      updateTask(ctx.db, ctx.userId, { pageId, line, raw: task.raw, done, due }, ctx.today);
      const what = done === true ? 'Ticked off' : done === false ? 'Reopened' : 'Changed';
      return { data: { ok: true }, summary: `${what} ${quoted(taskPlainText(task.text))}`, pageId };
    },
  }),
  tool({
    name: 'calendar',
    description:
      'The calendar of a date range (at most 62 days): tasks due (and done) per day, reminders, and which days have a journal note.',
    schema: z.object({ from: dateSchema, to: dateSchema }),
    run(ctx, { from, to }) {
      const end = to < from ? from : to > addDays(from, 61) ? addDays(from, 61) : to;
      const tasks = openTasks(ctx, 'all').filter((t) => (t.due && t.due >= from && t.due <= end) || (t.remind && t.remind.slice(0, 10) >= from && t.remind.slice(0, 10) <= end));
      const journal = new Set(
        ctx.db
          .select({ date: dailyNotes.date })
          .from(dailyNotes)
          .innerJoin(pages, eq(pages.id, dailyNotes.pageId))
          .where(and(eq(dailyNotes.userId, ctx.userId), gte(dailyNotes.date, from), lte(dailyNotes.date, end), isNull(pages.deletedAt)))
          .all()
          .map((r) => r.date),
      );
      const days = [];
      for (let day = from; day <= end; day = addDays(day, 1)) {
        const due = tasks.filter((t) => t.due === day || (!t.due && t.remind?.startsWith(day)));
        if (!due.length && !journal.has(day)) continue;
        days.push({
          date: day,
          weekday: new Date(`${day}T12:00:00Z`).toLocaleDateString('en', { weekday: 'long', timeZone: 'UTC' }),
          journal: journal.has(day),
          tasks: due.map((t) => ({ ref: taskRef(t), text: taskPlainText(t.text), done: t.done, remind: t.remind?.slice(11) ?? null, page: t.pageTitle })),
        });
      }
      return { data: { from, to: end, today: ctx.today, days }, summary: `Looked at the calendar ${from} – ${end}` };
    },
  }),
  tool({
    name: 'start_research',
    description:
      'Starts a web research job on a question: it searches the web, reads sources and writes a cited page into a notebook (a "Research" notebook unless given). Takes minutes; the page appears when done.',
    schema: z.object({
      question: z.string().min(3).max(2000),
      notebook: z.string().max(200).optional(),
      depth: z.enum(['quick', 'standard', 'deep']).optional(),
    }),
    run(ctx, { question, notebook: name, depth }) {
      let notebookId: string;
      if (name) notebookId = notebookByName(ctx, name).id;
      else {
        const existing = ctx.db
          .select({ id: notebooks.id })
          .from(notebooks)
          .where(and(eq(notebooks.userId, ctx.userId), eq(notebooks.title, 'Research'), isNull(notebooks.deletedAt)))
          .get();
        notebookId = existing?.id ?? newId();
        if (!existing) {
          const now = Date.now();
          ctx.db.insert(notebooks).values({ id: notebookId, userId: ctx.userId, title: 'Research', sortOrder: 9999, createdAt: now, updatedAt: now }).run();
        }
      }
      const job = ctx.jobs.start(ctx.userId, 'research', { question, depth: depth ?? 'standard', mode: 'web', notebookId, parentId: null });
      return { data: { jobId: job.id, status: job.status }, summary: `Started research on ${quoted(question)}` };
    },
  }),
  tool({
    name: 'research_status',
    description: 'How a research job started earlier is doing, and the page it wrote once done.',
    schema: z.object({ job_id: z.string().min(1).max(64) }),
    run(ctx, { job_id }) {
      const job = ctx.jobs.get(ctx.userId, job_id);
      const result = job.result as { pageId?: string; title?: string } | null;
      return { data: { status: job.status, progress: job.progress, error: job.error, page: result?.title, pageId: result?.pageId }, summary: 'Checked the research', pageId: result?.pageId };
    },
  }),
];

export const toolByName = new Map(TOOLS.map((t) => [t.name, t]));

/** The tools as the model sees them. */
export const toolSpecs = () =>
  TOOLS.map((t) => {
    const { $schema: _, ...parameters } = z.toJSONSchema(t.schema) as Record<string, unknown>;
    return { name: t.name, description: t.description, parameters };
  });

/** Runs one call of the model; failures are reported back to it (and shown) rather than thrown. */
export async function runTool(ctx: ToolContext, name: string, rawArgs: string): Promise<{ result: string; action: ChatAction }> {
  const t = toolByName.get(name);
  if (!t) return { result: JSON.stringify({ error: `Unknown tool ${name}` }), action: { tool: name, summary: `Unknown tool ${name}`, ok: false } };
  try {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawArgs || '{}');
    } catch {
      throw new Error('The arguments were not valid JSON');
    }
    const args = t.schema.safeParse(parsed);
    if (!args.success) throw new Error(`Invalid arguments: ${args.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
    const out = await t.run(ctx, args.data);
    return { result: JSON.stringify(out.data), action: { tool: name, summary: out.summary, pageId: out.pageId, ok: true } };
  } catch (err) {
    const message = (err as Error).message;
    return { result: JSON.stringify({ error: message }), action: { tool: name, summary: `${name.replace(/_/g, ' ')}: ${message}`, ok: false } };
  }
}
