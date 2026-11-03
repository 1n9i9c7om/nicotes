import { and, asc, count, desc, eq, gte, isNull, lte, max, min } from 'drizzle-orm';
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
import { searchGuide } from './help.js';
import { loadLinkContext, propagateRenames } from '../links.js';
import { ensureDailyNote } from '../routes/daily.js';
import { applyMove, createPage, descendantIds, findPage, trashPage } from '../routes/pages.js';
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
  /** Shown to the user: what was done, or the question for a step to confirm. */
  summary: string;
  pageId?: string;
  /** The step waits for the user, who answers with these buttons (see CONFIRMED). */
  confirm?: { yes: string; no: string };
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

/** Lines list_pages returns at most. */
const MAX_TREE_LINES = 400;

function liveNotebooks(ctx: ToolContext) {
  return ctx.db
    .select({ id: notebooks.id, title: notebooks.title })
    .from(notebooks)
    .where(and(eq(notebooks.userId, ctx.userId), isNull(notebooks.deletedAt)))
    .orderBy(asc(notebooks.sortOrder))
    .all();
}

/**
 * The notebooks with their page counts and the journal's extent, for the system prompt: the
 * model then knows what exists without remembering it from earlier messages.
 */
export function notesOverview(ctx: ToolContext): string {
  const counts = ctx.db
    .select({ title: notebooks.title, pages: count(pages.id) })
    .from(notebooks)
    .leftJoin(pages, and(eq(pages.notebookId, notebooks.id), isNull(pages.deletedAt)))
    .where(and(eq(notebooks.userId, ctx.userId), isNull(notebooks.deletedAt)))
    .groupBy(notebooks.id)
    .orderBy(asc(notebooks.sortOrder))
    .all();
  const journal = ctx.db
    .select({ days: count(dailyNotes.date), first: min(dailyNotes.date), last: max(dailyNotes.date) })
    .from(dailyNotes)
    .innerJoin(pages, eq(pages.id, dailyNotes.pageId))
    .where(and(eq(dailyNotes.userId, ctx.userId), isNull(pages.deletedAt)))
    .get();
  const books = counts.length ? `notebooks ${counts.map((n) => `"${n.title}" (${n.pages} pages)`).join(', ')}` : 'no notebooks yet';
  const days = journal?.days ? ` The journal has notes for ${journal.days} days, ${journal.first} to ${journal.last}.` : ' The journal is empty.';
  return `${books}.${days}`;
}

function notebookByName(ctx: ToolContext, name: string) {
  const all = liveNotebooks(ctx);
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

/** Where pages are: "Notebook › Parent › Page", looked up from one read of the account's pages. */
function pathFinder(ctx: ToolContext) {
  const notebookTitles = new Map(
    ctx.db.select({ id: notebooks.id, title: notebooks.title }).from(notebooks).where(eq(notebooks.userId, ctx.userId)).all().map((n) => [n.id, n.title]),
  );
  const all = new Map(
    ctx.db
      .select({ id: pages.id, title: pages.title, parentId: pages.parentId, notebookId: pages.notebookId })
      .from(pages)
      .where(and(eq(pages.userId, ctx.userId), isNull(pages.deletedAt)))
      .all()
      .map((p) => [p.id, p]),
  );
  return (id: string) => {
    const titles: string[] = [];
    let page = all.get(id);
    const notebook = notebookTitles.get(page?.notebookId ?? '') ?? '?';
    for (let depth = 0; page && depth < 50; depth++) {
      titles.unshift(page.title || 'Untitled');
      page = page.parentId ? all.get(page.parentId) : undefined;
    }
    return [notebook, ...titles].join(' › ');
  };
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
    name: 'nicotes_help',
    description:
      "Looks up how Nicotes itself works in its user guide: features, where a setting is (\"Settings → …\"), how to install or connect something. Ask in English keywords, e.g. \"canvas drawing\" or \"telegram reminders\". Returns the best matching sections and the guide's table of contents.",
    schema: z.object({ question: z.string().min(2).max(300) }),
    run(_ctx, { question }) {
      const { sections, contents } = searchGuide(question);
      if (!contents.length) return { data: { error: 'The user guide is not available on this server' }, summary: 'Looked in the Nicotes guide (missing)' };
      return {
        data: { version: process.env.NICOTES_VERSION || undefined, sections, contents },
        summary: sections.length ? `Looked up ${quoted(sections[0]!.title)} in the Nicotes guide` : `Looked in the Nicotes guide for ${quoted(question)} (nothing found)`,
      };
    },
  }),
  tool({
    name: 'search_notes',
    description: 'Full-text search over all pages (and PDFs and other files they show). Use short keyword queries; "#tag" filters by tag.',
    schema: z.object({ query: z.string().min(1).max(200), limit: z.number().int().min(1).max(20).optional() }),
    run(ctx, { query, limit }) {
      const hits = searchPages(ctx.db, ctx.userId, query, limit ?? 8);
      const path = pathFinder(ctx);
      return {
        data: hits.map((h) => ({ id: h.id, title: h.title, path: path(h.id), excerpt: plainExcerpt(h.excerpt), file: h.attachment?.filename })),
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
    description:
      'Reads a page: its Markdown, where it is ("path": notebook › parent pages › page), tags, subpages and when it changed. Accepts a page id or a title.',
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
      return {
        data: {
          id: page.id,
          title: page.title,
          path: pathFinder(ctx)(page.id),
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
    description:
      'The pages of a notebook (by title or id), or of all notebooks when none is given, as an indented tree: one line per page, "- Title [id]", subpages indented below their parent.',
    schema: z.object({ notebook: z.string().min(1).max(200).optional() }),
    run(ctx, { notebook: name }) {
      const books = name ? [notebookByName(ctx, name)] : liveNotebooks(ctx);
      const lines: string[] = [];
      for (const nb of books) {
        const rows = ctx.db
          .select({ id: pages.id, title: pages.title, parentId: pages.parentId })
          .from(pages)
          .where(and(eq(pages.notebookId, nb.id), isNull(pages.deletedAt)))
          .orderBy(asc(pages.sortOrder), asc(pages.createdAt))
          .all();
        const children = new Map<string | null, typeof rows>();
        for (const row of rows) children.set(row.parentId, [...(children.get(row.parentId) ?? []), row]);
        lines.push(`${nb.title} (notebook, ${rows.length} pages)`);
        const walk = (parentId: string | null, depth: number) => {
          for (const row of children.get(parentId) ?? []) {
            lines.push(`${'  '.repeat(depth)}- ${row.title || 'Untitled'} [${row.id}]`);
            walk(row.id, depth + 1);
          }
        };
        walk(null, 1);
      }
      const shown = lines.slice(0, MAX_TREE_LINES);
      if (lines.length > shown.length) shown.push(`[… ${lines.length - shown.length} more lines; ask for one notebook]`);
      return { data: { tree: shown.join('\n') }, summary: name ? `Looked at the pages of ${quoted(books[0]!.title)}` : 'Looked at all pages' };
    },
  }),
  tool({
    name: 'list_journal',
    description: 'The days that have a journal note (newest first), optionally between two dates (inclusive). Read one with read_journal.',
    schema: z.object({ from: dateSchema.optional(), to: dateSchema.optional() }),
    run(ctx, { from, to }) {
      const rows = ctx.db
        .select({ date: dailyNotes.date, id: dailyNotes.pageId })
        .from(dailyNotes)
        .innerJoin(pages, eq(pages.id, dailyNotes.pageId))
        .where(
          and(
            eq(dailyNotes.userId, ctx.userId),
            isNull(pages.deletedAt),
            from ? gte(dailyNotes.date, from) : undefined,
            to ? lte(dailyNotes.date, to) : undefined,
          ),
        )
        .orderBy(desc(dailyNotes.date))
        .limit(400)
        .all();
      return { data: { days: rows.length, notes: rows }, summary: `Looked at the journal (${rows.length} days)` };
    },
  }),
  tool({
    name: 'recent_pages',
    description: 'Pages changed most recently (newest first), with where they are and when they changed; optionally only since a date.',
    schema: z.object({ since: dateSchema.optional(), limit: z.number().int().min(1).max(50).optional() }),
    run(ctx, { since, limit }) {
      const rows = ctx.db
        .select({ id: pages.id, title: pages.title, updatedAt: pages.updatedAt })
        .from(pages)
        .where(and(eq(pages.userId, ctx.userId), isNull(pages.deletedAt), since ? gte(pages.updatedAt, Date.parse(`${since}T00:00:00Z`)) : undefined))
        .orderBy(desc(pages.updatedAt))
        .limit(limit ?? 15)
        .all();
      const path = pathFinder(ctx);
      return {
        data: rows.map((r) => ({ id: r.id, path: path(r.id), changed: new Date(r.updatedAt).toISOString() })),
        summary: `Looked at recently changed pages (${rows.length})`,
      };
    },
  }),
  tool({
    name: 'create_page',
    description:
      'Creates a page with Markdown content in a notebook, at its top level or below a parent page (give the parent\'s id when titles are alike). Link other pages as [[Title]]. Returns where the page is.',
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
      const path = pathFinder(ctx)(page.id);
      return { data: { id: page.id, title: page.title, path }, summary: `Created ${quoted(path, 120)}`, pageId: page.id };
    },
  }),
  tool({
    name: 'move_page',
    description:
      'Moves a page (with its subpages) below another page ("parent"), or to the top level of a notebook (parent null), and/or renames it ("title"). Links to it are updated. Returns where it is now.',
    schema: z.object({
      page: z.string().min(1).max(300),
      parent: z.string().min(1).max(300).nullable().optional(),
      notebook: z.string().min(1).max(200).optional(),
      title: z.string().trim().min(1).max(300).optional(),
    }),
    run(ctx, { page: name, parent, notebook: notebookName, title }) {
      const page = pageByName(ctx, name);
      if (parent === undefined && !notebookName && !title) throw new Error('Give a new parent, notebook or title');
      const parentPage = parent ? pageByName(ctx, parent) : null;
      const notebookId = notebookName ? notebookByName(ctx, notebookName).id : (parentPage?.notebookId ?? page.notebookId);
      if (parentPage && parentPage.notebookId !== notebookId) throw new Error('The parent page is in another notebook');
      // Only a title: the page stays where it is. A notebook without a parent: its top level.
      const parentId = parent === undefined && !notebookName ? page.parentId : (parentPage?.id ?? null);
      const moving = parentId !== page.parentId || notebookId !== page.notebookId;
      const renaming = !!title && title !== page.title;
      ctx.db.transaction((tx) =>
        propagateRenames(tx, ctx.userId, () => {
          if (moving) applyMove(tx, ctx.userId, page.id, { notebookId, parentId, index: Number.MAX_SAFE_INTEGER });
          if (renaming) tx.update(pages).set({ title, updatedAt: Date.now() }).where(eq(pages.id, page.id)).run();
        }),
      );
      const path = pathFinder(ctx)(page.id);
      const summary = moving ? `Moved ${quoted(page.title || 'Untitled')} to ${quoted(path, 120)}` : renaming ? `Renamed ${quoted(page.title || 'Untitled')} to ${quoted(title!)}` : `Left ${quoted(path, 120)} as it was`;
      return { data: { ok: true, path }, summary, pageId: page.id };
    },
  }),
  tool({
    name: 'delete_page',
    description:
      'Asks the user to confirm deleting a page with its subpages: they get buttons for it, and nothing is deleted until they press one. Deleted pages go to the trash, where they can be restored. Tell the user it waits for their confirmation; never say it is deleted.',
    schema: z.object({ page: z.string().min(1).max(300) }),
    run(ctx, { page: name }) {
      const page = pageByName(ctx, name);
      const subpages = descendantIds(ctx.db, ctx.userId, page.id).length;
      const path = pathFinder(ctx)(page.id);
      return {
        data: { waiting_for_user: true, path, subpages },
        summary: `Delete ${quoted(path, 120)}${subpages ? ` and its ${subpages === 1 ? 'subpage' : `${subpages} subpages`}` : ''}?`,
        pageId: page.id,
        confirm: { yes: 'Move to trash', no: 'Keep it' },
      };
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

/**
 * Steps that wait for the user: what happens when they confirm or decline. Both return
 * what is shown (and told to the model) from then on.
 */
const CONFIRMED: Record<string, { yes: (db: Db, userId: string, action: ChatAction) => string; no: (db: Db, userId: string, action: ChatAction) => string }> = {
  delete_page: {
    yes(db, userId, { pageId }) {
      const page = pageId ? db.select({ title: pages.title }).from(pages).where(and(eq(pages.id, pageId), eq(pages.userId, userId), isNull(pages.deletedAt))).get() : undefined;
      if (!page) return 'The page was already deleted';
      const count = trashPage(db, userId, pageId!);
      return `Moved ${quoted(page.title || 'Untitled')}${count > 1 ? ` and ${count - 1 === 1 ? 'its subpage' : `${count - 1} subpages`}` : ''} to the trash`;
    },
    no: (_db, _userId, action) => `Kept it: ${action.summary.replace(/^Delete /, '').replace(/\?$/, '')}`,
  },
};

/** Carries out (yes) or drops (no) a step the user was asked to confirm; returns its new summary. */
export function answerConfirmation(db: Db, userId: string, action: ChatAction, yes: boolean): string {
  const step = CONFIRMED[action.tool];
  if (!step) throw new Error(`Nothing to confirm for ${action.tool}`);
  return yes ? step.yes(db, userId, action) : step.no(db, userId, action);
}

/** The tools as the model sees them. */
export const toolSpecs = () =>
  TOOLS.map((t) => {
    const { $schema: _, ...parameters } = z.toJSONSchema(t.schema) as Record<string, unknown>;
    return { name: t.name, description: t.description, parameters };
  });

/** A call's arguments to keep with its step: still JSON, with long texts (page content) cut. */
function keptArgs(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw || '{}'), (_key, value: unknown) => (typeof value === 'string' && value.length > 300 ? `${value.slice(0, 300)}…` : value));
  } catch {
    return '{}';
  }
}

/** Runs one call of the model; failures are reported back to it (and shown) rather than thrown. */
export async function runTool(ctx: ToolContext, name: string, rawArgs: string): Promise<{ result: string; action: ChatAction }> {
  const outcome = await callTool(ctx, name, rawArgs);
  return { ...outcome, action: { ...outcome.action, args: keptArgs(rawArgs) } };
}

async function callTool(ctx: ToolContext, name: string, rawArgs: string): Promise<{ result: string; action: ChatAction }> {
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
    const action: ChatAction = { tool: name, summary: out.summary, pageId: out.pageId, ok: true };
    if (out.confirm) action.confirm = { id: newId(), state: 'pending', ...out.confirm };
    return { result: JSON.stringify(out.data), action };
  } catch (err) {
    const message = (err as Error).message;
    return { result: JSON.stringify({ error: message }), action: { tool: name, summary: `${name.replace(/_/g, ' ')}: ${message}`, ok: false } };
  }
}
