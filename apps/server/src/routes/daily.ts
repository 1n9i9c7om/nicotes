import { and, eq, gte, isNull, lte, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { dailyRequestSchema, dateSchema, normalizeTag, type DailyEntry, type Page } from '@nicotes/shared';
import type { AppEnv } from '../auth.js';
import type { Db } from '../db/index.js';
import { dailyNotes, notebooks, pages } from '../db/schema.js';
import { readJson } from '../http.js';
import { newId } from '../ids.js';
import { indexPageLinks, type Tx } from '../links.js';
import type { SettingsStore } from '../settings.js';
import { findPage } from './pages.js';
import { setPageTags } from './tags.js';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** The journal notebook: the configured one, else one called "Journal" (created on demand). */
function journalNotebook(tx: Tx, userId: string, settings: SettingsStore): string {
  const configured = settings.view(userId).daily.notebookId;
  const live = (id: string) =>
    tx
      .select({ id: notebooks.id })
      .from(notebooks)
      .where(and(eq(notebooks.id, id), eq(notebooks.userId, userId), isNull(notebooks.deletedAt)))
      .get();
  if (configured && live(configured)) return configured;
  const byName = tx
    .select({ id: notebooks.id })
    .from(notebooks)
    .where(and(eq(notebooks.userId, userId), isNull(notebooks.deletedAt), sql`lower(${notebooks.title}) = 'journal'`))
    .get();
  if (byName) return byName.id;
  const id = newId();
  const now = Date.now();
  const last = tx
    .select({ v: sql<number>`max(${notebooks.sortOrder})` })
    .from(notebooks)
    .where(eq(notebooks.userId, userId))
    .get();
  tx.insert(notebooks)
    .values({ id, userId, title: 'Journal', color: '#fbbf24', sortOrder: (last?.v ?? -1) + 1, createdAt: now, updatedAt: now })
    .run();
  return id;
}

/** Finds or creates a page by title under a parent, ordered by `sortOrder` (year, month, day). */
function folder(tx: Tx, userId: string, notebookId: string, parentId: string | null, title: string, sortOrder: number) {
  const existing = tx
    .select({ id: pages.id })
    .from(pages)
    .where(
      and(
        eq(pages.userId, userId),
        eq(pages.notebookId, notebookId),
        parentId ? eq(pages.parentId, parentId) : isNull(pages.parentId),
        eq(pages.title, title),
        isNull(pages.deletedAt),
      ),
    )
    .get();
  if (existing) return existing.id;
  const id = newId();
  const now = Date.now();
  tx.insert(pages).values({ id, userId, notebookId, parentId, title, sortOrder, createdAt: now, updatedAt: now }).run();
  return id;
}

/** The journal note of a date, created (from `content` and `tags`) if there is none yet. */
export function ensureDailyNote(
  db: Db,
  settings: SettingsStore,
  userId: string,
  date: string,
  content = '',
  tags: string[] = [],
): { pageId: string; created: boolean } {
  return db.transaction((tx): { pageId: string; created: boolean } => {
    const mapped = tx
      .select({ pageId: dailyNotes.pageId, deletedAt: pages.deletedAt })
      .from(dailyNotes)
      .innerJoin(pages, eq(pages.id, dailyNotes.pageId))
      .where(and(eq(dailyNotes.userId, userId), eq(dailyNotes.date, date)))
      .get();
    if (mapped && mapped.deletedAt === null) return { pageId: mapped.pageId, created: false };
    // The old note is in the trash: start a new one (restoring the old one keeps it findable by title).
    if (mapped) tx.delete(dailyNotes).where(and(eq(dailyNotes.userId, userId), eq(dailyNotes.date, date))).run();

    const [y, m, d] = date.split('-').map(Number) as [number, number, number];
    const notebookId = journalNotebook(tx, userId, settings);
    const year = folder(tx, userId, notebookId, null, String(y), y);
    const month = folder(tx, userId, notebookId, year, MONTHS[m - 1]!, m);
    const id = newId();
    const now = Date.now();
    tx.insert(pages)
      .values({ id, userId, notebookId, parentId: month, title: date, content, sortOrder: d, createdAt: now, updatedAt: now })
      .run();
    tx.insert(dailyNotes).values({ userId, date, pageId: id }).run();
    if (content) indexPageLinks(tx, userId, id, content);
    const names = [...new Set(tags.map(normalizeTag).filter(Boolean))];
    if (names.length) setPageTags(tx, userId, id, names);
    return { pageId: id, created: true };
  });
}

export function dailyRoutes(db: Db, settings: SettingsStore) {
  return new Hono<AppEnv>()
    .get('/', (c) => {
      const from = dateSchema.safeParse(c.req.query('from'));
      const to = dateSchema.safeParse(c.req.query('to'));
      const rows = db
        .select({ date: dailyNotes.date, pageId: dailyNotes.pageId })
        .from(dailyNotes)
        .innerJoin(pages, eq(pages.id, dailyNotes.pageId))
        .where(
          and(
            eq(dailyNotes.userId, c.var.user.id),
            isNull(pages.deletedAt),
            from.success ? gte(dailyNotes.date, from.data) : undefined,
            to.success ? lte(dailyNotes.date, to.data) : undefined,
          ),
        )
        .orderBy(dailyNotes.date)
        .all();
      return c.json(rows satisfies DailyEntry[]);
    })
    .post('/', async (c) => {
      const { date, content, tags } = await readJson(c, dailyRequestSchema);
      const userId = c.var.user.id;
      const result = ensureDailyNote(db, settings, userId, date, content, tags);
      const page: Page = findPage(db, userId, result.pageId);
      return c.json({ page, created: result.created });
    });
}
