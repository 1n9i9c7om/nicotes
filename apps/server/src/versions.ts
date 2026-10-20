import { desc, eq, inArray } from 'drizzle-orm';
import type { VersionReason } from '@nicotes/shared';
import { pageVersions } from './db/schema.js';
import { newId } from './ids.js';
import type { Tx } from './links.js';

/** Autosave runs every few seconds; keep at most one "edit" snapshot per this interval. */
export const SNAPSHOT_INTERVAL_MS = 10 * 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;
const KEEP_ALL_MS = DAY;
const KEEP_DAILY_MS = 90 * DAY;
const MAX_VERSIONS = 200;

/**
 * Which snapshots survive retention: everything from the last 24 hours, then the newest
 * per (UTC) day for 90 days, and never more than 200 in total. `rows` are newest first.
 */
export function versionsToKeep(rows: { id: string; createdAt: number }[], now: number): Set<string> {
  const keep: string[] = [];
  const days = new Set<number>();
  for (const row of rows) {
    const age = now - row.createdAt;
    if (age <= KEEP_ALL_MS) {
      keep.push(row.id);
      continue;
    }
    if (age > KEEP_DAILY_MS) continue;
    const day = Math.floor(row.createdAt / DAY);
    if (days.has(day)) continue;
    days.add(day);
    keep.push(row.id);
  }
  return new Set(keep.slice(0, MAX_VERSIONS));
}

interface PageState {
  id: string;
  userId: string;
  title: string;
  content: string;
}

/**
 * Saves the page's current state as a version. Edits are throttled to one snapshot per
 * interval; `force` (rewrites, restores) always snapshots. Empty pages and states equal to
 * the latest snapshot are skipped. Returns whether a snapshot was taken.
 */
export function snapshotPage(tx: Tx, page: PageState, reason: VersionReason, force = false, now = Date.now()): boolean {
  if (!page.title.trim() && !page.content.trim()) return false;
  const latest = tx
    .select({ title: pageVersions.title, content: pageVersions.content, createdAt: pageVersions.createdAt })
    .from(pageVersions)
    .where(eq(pageVersions.pageId, page.id))
    .orderBy(desc(pageVersions.createdAt))
    .limit(1)
    .get();
  if (latest && latest.content === page.content && latest.title === page.title) return false;
  if (!force && latest && now - latest.createdAt < SNAPSHOT_INTERVAL_MS) return false;

  tx.insert(pageVersions)
    .values({ id: newId(), pageId: page.id, userId: page.userId, title: page.title, content: page.content, reason, createdAt: now })
    .run();

  const rows = tx
    .select({ id: pageVersions.id, createdAt: pageVersions.createdAt })
    .from(pageVersions)
    .where(eq(pageVersions.pageId, page.id))
    .orderBy(desc(pageVersions.createdAt))
    .all();
  const keep = versionsToKeep(rows, now);
  const drop = rows.filter((r) => !keep.has(r.id)).map((r) => r.id);
  if (drop.length) tx.delete(pageVersions).where(inArray(pageVersions.id, drop)).run();
  return true;
}
