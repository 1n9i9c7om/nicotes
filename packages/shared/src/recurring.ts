/**
 * Recurring tasks, written like Obsidian's Tasks plugin: `- [ ] Water the plants 🔁 every week
 * 📅 2026-11-02`. Ticking one off adds the next occurrence above it, with the due date (and a
 * dated reminder) moved on; the ticked one stays as a record.
 *
 * Rules: every day / week / month / year, every N days / weeks / months / years, daily, weekly,
 * monthly, yearly, every weekday, every monday (, thursday …), every week on monday,
 * every month on the 15th / on the last; "when done" counts from the day it was ticked off
 * instead of the due date.
 */

/** `🔁 every week` up to the next task emoji or the end of the line. */
export const RECUR_TOKEN = /🔁\s*([^📅⏰✅⏳🛫➕🔼🔽⏫⏬🆔⛔]*[^\s📅⏰✅⏳🛫➕🔼🔽⏫⏬🆔⛔])/u;

type Unit = 'day' | 'week' | 'month' | 'year';

export interface RecurRule {
  unit: Unit;
  every: number;
  /** 0 = Sunday … 6 = Saturday, for weekly rules on given days. */
  weekdays: number[];
  /** Day of the month for monthly rules; -1 is the last day. */
  monthDay: number | null;
  whenDone: boolean;
}

const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const ALIASES: Record<string, string> = { daily: 'every day', weekly: 'every week', monthly: 'every month', yearly: 'every year', annually: 'every year' };

const dayOf = (word: string) => DAYS.findIndex((d) => d.startsWith(word.slice(0, 3)) && d.startsWith(word));

/** Reads a rule like "every 2 weeks on monday when done"; null if it is not one. */
export function parseRecurRule(text: string): RecurRule | null {
  let rule = text.trim().toLowerCase().replace(/\s+/g, ' ');
  const whenDone = / when done$/.test(rule);
  rule = rule.replace(/ when done$/, '');
  rule = ALIASES[rule] ?? rule;
  if (!rule.startsWith('every ')) return null;
  rule = rule.slice(6);

  if (/^weekdays?$/.test(rule)) return { unit: 'week', every: 1, weekdays: [1, 2, 3, 4, 5], monthDay: null, whenDone };
  const days = rule.split(/\s*(?:,|\band\b)\s*/).filter(Boolean);
  if (days.length && days.every((d) => dayOf(d) >= 0)) return { unit: 'week', every: 1, weekdays: days.map(dayOf), monthDay: null, whenDone };

  const m = /^(?:(\d{1,3}) )?(day|week|month|year)s?(?: on (.+))?$/.exec(rule);
  if (!m) return null;
  const every = m[1] ? Number(m[1]) : 1;
  if (every < 1) return null;
  const unit = m[2] as Unit;
  const on = m[3]?.trim() ?? null;
  let weekdays: number[] = [];
  let monthDay: number | null = null;
  if (on && unit === 'week') {
    const list = on.split(/\s*(?:,|\band\b)\s*/).filter(Boolean);
    if (!list.every((d) => dayOf(d) >= 0)) return null;
    weekdays = list.map(dayOf);
  } else if (on && unit === 'month') {
    const day = /^the (last|\d{1,2})(?:st|nd|rd|th)?(?: day)?$/.exec(on);
    if (!day) return null;
    monthDay = day[1] === 'last' ? -1 : Number(day[1]);
    if (monthDay === 0 || monthDay > 31) return null;
  } else if (on) return null;
  return { unit, every, weekdays, monthDay, whenDone };
}

const toDate = (iso: string) => new Date(`${iso}T12:00:00Z`);
const toIso = (d: Date) => d.toISOString().slice(0, 10);
const daysIn = (year: number, month: number) => new Date(Date.UTC(year, month + 1, 0)).getUTCDate();

function addMonths(d: Date, months: number, day: number | null) {
  const total = d.getUTCMonth() + months;
  const year = d.getUTCFullYear() + Math.floor(total / 12);
  const month = ((total % 12) + 12) % 12;
  const want = day === -1 ? 31 : (day ?? d.getUTCDate());
  return new Date(Date.UTC(year, month, Math.min(want, daysIn(year, month)), 12));
}

/** The occurrence after `from` (YYYY-MM-DD). */
export function nextOccurrence(rule: RecurRule, from: string): string {
  const d = toDate(from);
  if (rule.unit === 'day') d.setUTCDate(d.getUTCDate() + rule.every);
  else if (rule.unit === 'week' && rule.weekdays.length) {
    const start = d.getUTCDay();
    do d.setUTCDate(d.getUTCDate() + 1);
    while (!rule.weekdays.includes(d.getUTCDay()));
    // "every 2 weeks on monday": a later week of the cycle once this week's days are used up.
    if (rule.every > 1 && d.getUTCDay() <= start) d.setUTCDate(d.getUTCDate() + 7 * (rule.every - 1));
  } else if (rule.unit === 'week') d.setUTCDate(d.getUTCDate() + 7 * rule.every);
  else if (rule.unit === 'month') return toIso(addMonths(d, rule.every, rule.monthDay));
  else return toIso(addMonths(d, 12 * rule.every, null));
  return toIso(d);
}

const DUE = /(📅\s*|\bdue:|(?<![\w.])@)(\d{4}-\d{2}-\d{2})(?!\d)/gu;
const REMIND_DATE = /(⏰\s*)(\d{4}-\d{2}-\d{2})(?=\s+(?:[01]?\d|2[0-3]):[0-5]\d)/gu;

const daysBetween = (a: string, b: string) => Math.round((toDate(b).getTime() - toDate(a).getTime()) / 86_400_000);
const shift = (iso: string, days: number) => {
  const d = toDate(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return toIso(d);
};

export interface Recurrence {
  /** The rule as written, e.g. "every week". */
  rule: string;
  /** The current due date, if any, and the next one. */
  due: string | null;
  next: string;
  /** Date replacements for the next occurrence's text (due date, dated reminders). */
  replace: [string, string][];
}

/** What ticking off a task with this text (without the checkbox) moves on; null if it does not recur. */
export function recurrenceOf(body: string, today: string): Recurrence | null {
  const written = RECUR_TOKEN.exec(body)?.[1];
  const rule = written ? parseRecurRule(written) : null;
  if (!rule || !written) return null;
  const due = [...body.matchAll(DUE)].at(-1)?.[2] ?? null;
  const next = nextOccurrence(rule, rule.whenDone || !due ? today : due);
  const replace = new Map<string, string>();
  if (due) replace.set(due, next);
  // A reminder on a day of its own keeps its distance to the due date (or to today).
  for (const m of body.matchAll(REMIND_DATE)) {
    if (!replace.has(m[2]!)) replace.set(m[2]!, shift(m[2]!, daysBetween(due ?? today, next)));
  }
  return { rule: written, due, next, replace: [...replace] };
}

/** Moves the due date and dated reminders in a piece of task text on to the next occurrence. */
export function moveDates(text: string, recurrence: Recurrence): string {
  const moved = (mark: string, date: string) => `${mark}${recurrence.replace.find(([a]) => a === date)?.[1] ?? date}`;
  return text.replace(DUE, (_m, mark: string, date: string) => moved(mark, date)).replace(REMIND_DATE, (_m, mark: string, date: string) => moved(mark, date));
}

/** The next occurrence of a task's body text: dates moved on, or a due date added. */
export function nextBody(body: string, recurrence: Recurrence): string {
  const text = moveDates(body, recurrence);
  return recurrence.due ? text : `${text.replace(/\s+$/, '')} 📅 ${recurrence.next}`;
}

const TASK = /^(\s*)([-*+]|\d+[.)])(\s+)\[([ xX])\](\s+)(.*)$/;

/**
 * Ticks off line `index` of a page's lines; a recurring task gets its next occurrence inserted
 * above it. Returns the new lines (the ticked task moves down one line then).
 */
export function tickTaskLine(lines: string[], index: number, today: string): string[] {
  const m = TASK.exec(lines[index] ?? '');
  if (!m) return lines;
  const [, indent, bullet, space, box, gap, body] = m as unknown as string[];
  const out = [...lines];
  out[index] = `${indent}${bullet}${space}[x]${gap}${body}`;
  const recurrence = box === ' ' ? recurrenceOf(body!, today) : null;
  if (recurrence) out.splice(index, 0, `${indent}${bullet}${space}[ ]${gap}${nextBody(body!, recurrence)}`);
  return out;
}
