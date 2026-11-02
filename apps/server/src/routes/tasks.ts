import { and, eq, isNull, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import {
  appendTask,
  parseTasks,
  taskCreateSchema,
  taskUpdateSchema,
  TEMPLATE_TAG,
  tickTaskLine,
  updateTaskLine,
  type Page,
  type PageTask,
  type TaskStatus,
  type TaskUpdate,
} from '@nicotes/shared';
import type { AppEnv } from '../auth.js';
import type { Db } from '../db/index.js';
import { pages } from '../db/schema.js';
import { readJson } from '../http.js';
import { indexPageLinks, type Tx } from '../links.js';
import { snapshotPage } from '../versions.js';
import { findPage } from './pages.js';
import type { SettingsStore } from '../settings.js';
import { localTime, timeZoneOf } from '../time.js';
import { inheritedTags, tagsByPage } from './tags.js';

const MAX_TASKS = 2000;

/**
 * Tasks of all live pages, read from their Markdown on demand (cheap: only pages containing a
 * checkbox are parsed). Templates are skipped (their tasks are placeholders), and so are pages
 * carrying one of `excludeTags`, directly or inherited (e.g. ingredient lists of recipes).
 */
export function listTasks(db: Db, userId: string, status: TaskStatus, excludeTags: string[] = []): PageTask[] {
  const rows = db
    .select({
      id: pages.id,
      notebookId: pages.notebookId,
      title: pages.title,
      content: pages.content,
      version: pages.version,
      updatedAt: pages.updatedAt,
    })
    .from(pages)
    .where(
      and(
        eq(pages.userId, userId),
        isNull(pages.deletedAt),
        sql`(instr(${pages.content}, '[ ]') > 0 OR instr(${pages.content}, '[x]') > 0 OR instr(${pages.content}, '[X]') > 0)`,
      ),
    )
    .all();
  const skip = new Set([TEMPLATE_TAG, ...excludeTags]);
  const direct = tagsByPage(db, userId);
  const inherited = inheritedTags(db, userId);
  const tasks: PageTask[] = [];
  for (const row of rows) {
    if ([...(direct.get(row.id) ?? []), ...(inherited.get(row.id) ?? [])].some((t) => skip.has(t))) continue;
    for (const task of parseTasks(row.content)) {
      if (status === 'open' ? task.done : status === 'done' ? !task.done : false) continue;
      tasks.push({ ...task, pageId: row.id, pageTitle: row.title, notebookId: row.notebookId, version: row.version, pageUpdatedAt: row.updatedAt });
    }
  }
  return tasks
    .sort(
      (a, b) =>
        Number(a.done) - Number(b.done) ||
        (a.due ?? '9999').localeCompare(b.due ?? '9999') ||
        b.pageUpdatedAt - a.pageUpdatedAt ||
        a.line - b.line,
    )
    .slice(0, MAX_TASKS);
}

/** Saves new page content the way the editor would (version bump, snapshot, link index). */
export function saveContent(tx: Tx, userId: string, page: Page, content: string) {
  snapshotPage(tx, { ...page, userId }, 'edit');
  tx.update(pages)
    .set({ content, version: page.version + 1, updatedAt: Date.now() })
    .where(eq(pages.id, page.id))
    .run();
  indexPageLinks(tx, userId, page.id, content);
}

/**
 * Ticks a task off (or reopens it) and/or sets its due date, if its line is unchanged. A
 * recurring task ticked off gets its next occurrence above it; `today` is the account's date.
 */
export function updateTask(db: Db, userId: string, input: TaskUpdate, today: string) {
  db.transaction((tx) => {
    const page = findPage(tx, userId, input.pageId);
    const lines = page.content.split('\n');
    // Line numbers are only valid while the line is unchanged.
    if (lines[input.line] !== input.raw) {
      throw new HTTPException(409, { message: 'This task was changed in the meantime' });
    }
    lines[input.line] = updateTaskLine(input.raw, { due: input.due });
    const updated = input.done === true ? tickTaskLine(lines, input.line, today) : lines;
    if (input.done === false) updated[input.line] = updateTaskLine(updated[input.line]!, { done: false });
    saveContent(tx, userId, page, updated.join('\n'));
  });
}

/** Adds an open task to a page (appendTask decides where in it). */
export function addTask(db: Db, userId: string, pageId: string, text: string, due?: string | null) {
  db.transaction((tx) => {
    const page = findPage(tx, userId, pageId);
    saveContent(tx, userId, page, appendTask(page.content, text, due));
  });
}

export function taskRoutes(db: Db, settings: SettingsStore) {
  return new Hono<AppEnv>()
    .get('/', (c) => {
      const status = (['open', 'done', 'all'] as const).find((s) => s === c.req.query('status')) ?? 'open';
      const { excludeTags } = settings.view(c.var.user.id).tasks;
      return c.json(listTasks(db, c.var.user.id, status, excludeTags));
    })
    .patch('/', async (c) => {
      const input = await readJson(c, taskUpdateSchema);
      updateTask(db, c.var.user.id, input, localTime(Date.now(), timeZoneOf(settings, c.var.user.id)).date);
      return c.json(findPage(db, c.var.user.id, input.pageId));
    })
    .post('/', async (c) => {
      const input = await readJson(c, taskCreateSchema);
      addTask(db, c.var.user.id, input.pageId, input.text, input.due);
      return c.json(findPage(db, c.var.user.id, input.pageId), 201);
    });
}
