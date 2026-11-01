import type { SettingsStore } from './settings.js';

/** "YYYY-MM-DD" and "HH:MM" at `time` in a time zone. */
export function localTime(time: number, timeZone: string): { date: string; time: string } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(time)
      .map((p) => [p.type, p.value]),
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

/** How far a time zone's clock is ahead of UTC at `time`, in milliseconds. */
function zoneOffset(time: number, timeZone: string) {
  const { date, time: hm } = localTime(time, timeZone);
  const wall = Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)), Number(hm.slice(0, 2)), Number(hm.slice(3, 5)));
  return wall - Math.floor(time / 60_000) * 60_000;
}

/** When the day "YYYY-MM-DD" starts in a time zone. */
export function startOfDay(date: string, timeZone: string): number {
  const wall = Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)));
  // The offset at midnight itself, which differs from the guess's on a daylight saving day.
  const guess = wall - zoneOffset(wall, timeZone);
  return wall - zoneOffset(guess, timeZone);
}

/** The account's time zone (Settings → Reminders), else the server's. */
export const timeZoneOf = (settings: SettingsStore, userId: string) =>
  settings.reminders(userId).timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
