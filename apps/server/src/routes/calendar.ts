import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import { taskPlainText, type PageTask } from '@nicotes/shared';
import { LoginLimiter } from '../auth.js';
import type { Db } from '../db/index.js';
import { notebooks } from '../db/schema.js';
import { clientIp } from '../http.js';
import type { SettingsStore } from '../settings.js';
import { tokenAccess } from '../tokens.js';
import { listTasks } from './tasks.js';

/** RFC 5545 text: backslash, semicolon, comma and line breaks are escaped. */
const escapeText = (text: string) => text.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

/** RFC 5545 lines are at most 75 octets; longer ones continue on lines starting with a space. */
function fold(line: string): string {
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= 75) return line;
  const parts: string[] = [];
  let start = 0;
  while (start < bytes.length) {
    let end = Math.min(start + (start === 0 ? 75 : 74), bytes.length);
    // Never split a UTF-8 character: continuation bytes look like 10xxxxxx.
    while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
    parts.push(bytes.subarray(start, end).toString('utf8'));
    start = end;
  }
  return parts.join('\r\n ');
}

const icsDate = (iso: string) => iso.replaceAll('-', '');
const nextDay = (iso: string) => new Date(Date.parse(`${iso}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
const stamp = (time: number) => new Date(time).toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');

/** The address the feed was requested at, also behind a reverse proxy. */
function origin(c: Context): string {
  const url = new URL(c.req.url);
  const proto = c.req.header('x-forwarded-proto')?.split(',')[0]?.trim();
  const host = c.req.header('x-forwarded-host')?.split(',')[0]?.trim();
  return `${proto ?? url.protocol.replace(':', '')}://${host ?? url.host}`;
}

/**
 * Open tasks with a due date as all-day events. The UID hashes page, text and date, so an
 * event keeps its identity when other lines of the page change.
 */
export function tasksCalendar(tasks: PageTask[], notebookTitles: Map<string, string>, base: string, now = Date.now()): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Nicotes//Tasks//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:Nicotes tasks',
    'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
    'X-PUBLISHED-TTL:PT1H',
  ];
  const seen = new Set<string>();
  for (const task of tasks) {
    if (task.done || !task.due) continue;
    let uid = createHash('sha256').update(`${task.pageId}\u0000${task.text}\u0000${task.due}`).digest('hex').slice(0, 24);
    while (seen.has(uid)) uid += '-';
    seen.add(uid);
    const url = `${base}/p/${task.pageId}`;
    const notebook = notebookTitles.get(task.notebookId);
    lines.push(
      'BEGIN:VEVENT',
      `UID:${uid}@nicotes`,
      `DTSTAMP:${stamp(now)}`,
      `DTSTART;VALUE=DATE:${icsDate(task.due)}`,
      `DTEND;VALUE=DATE:${icsDate(nextDay(task.due))}`,
      `SUMMARY:${escapeText(taskPlainText(task.text) || 'Task')}`,
      `DESCRIPTION:${escapeText(`From “${task.pageTitle || 'Untitled'}”${task.heading ? ` › ${task.heading}` : ''}\n${url}`)}`,
      `URL:${url}`,
      ...(notebook ? [`CATEGORIES:${escapeText(notebook)}`] : []),
      'TRANSP:TRANSPARENT',
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}

/**
 * GET /api/calendar/<token>.ics — the open tasks with due dates, for calendar apps. No
 * session: the calendar token in the address is the key. Unknown tokens answer 404 and are
 * rate-limited per IP.
 */
export function calendarRoutes(db: Db, settings: SettingsStore) {
  const failures = new LoginLimiter(20);
  return new Hono().get('/:file', (c) => {
    const key = clientIp(c);
    if (failures.isBlocked(key)) return c.text('Too many wrong calendar links, try again later', 429);
    const token = c.req.param('file').replace(/\.ics$/, '');
    const access = tokenAccess(db, token);
    if (!access || access.scope !== 'calendar') {
      failures.fail(key);
      return c.text('Not found', 404);
    }
    const userId = access.user.id;
    const { excludeTags } = settings.view(userId).tasks;
    const titles = new Map(
      db.select({ id: notebooks.id, title: notebooks.title }).from(notebooks).where(eq(notebooks.userId, userId)).all().map((n) => [n.id, n.title]),
    );
    const body = tasksCalendar(listTasks(db, userId, 'open', excludeTags), titles, origin(c));
    return c.body(body, 200, {
      'content-type': 'text/calendar; charset=utf-8',
      'content-disposition': 'inline; filename="nicotes-tasks.ics"',
      'cache-control': 'private, max-age=300',
    });
  });
}
