import { localDate, parseDate } from './daily';

export type Bucket = 'overdue' | 'today' | 'tomorrow' | 'week' | 'later' | 'none' | 'done';

export const BUCKETS: Bucket[] = ['overdue', 'today', 'tomorrow', 'week', 'later', 'none', 'done'];

export const BUCKET_LABELS: Record<Bucket, string> = {
  overdue: 'Overdue',
  today: 'Today',
  tomorrow: 'Tomorrow',
  week: 'Next 7 days',
  later: 'Later',
  none: 'No date',
  done: 'Done',
};

export const addDays = (iso: string, days: number) => {
  const d = parseDate(iso);
  d.setDate(d.getDate() + days);
  return localDate(d);
};

/** Which due-date group a task belongs to (dates are local YYYY-MM-DD strings). */
export function dueBucket(due: string | null, today: string): Bucket {
  if (!due) return 'none';
  if (due < today) return 'overdue';
  if (due === today) return 'today';
  if (due === addDays(today, 1)) return 'tomorrow';
  if (due <= addDays(today, 7)) return 'week';
  return 'later';
}

/** "Today", "Tomorrow", a weekday within the next week, else "26 Oct" (with the year if not this year). */
export function dueLabel(due: string, today: string): string {
  if (due === today) return 'Today';
  if (due === addDays(today, 1)) return 'Tomorrow';
  if (due === addDays(today, -1)) return 'Yesterday';
  const date = parseDate(due);
  if (due > today && due <= addDays(today, 6)) return date.toLocaleDateString('en', { weekday: 'long' });
  return date.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    ...(due.slice(0, 4) === today.slice(0, 4) ? {} : { year: 'numeric' }),
  });
}
