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

/** The account's time zone (Settings → Reminders), else the server's. */
export const timeZoneOf = (settings: SettingsStore, userId: string) =>
  settings.reminders(userId).timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
