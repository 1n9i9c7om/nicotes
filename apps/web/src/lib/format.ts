import { withoutColors } from '@nicotes/shared';

// English like the rest of the UI (the browser locale would mix languages).
const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

const units: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 24 * 3600],
  ['month', 30 * 24 * 3600],
  ['week', 7 * 24 * 3600],
  ['day', 24 * 3600],
  ['hour', 3600],
  ['minute', 60],
];

export function timeAgo(timestamp: number): string {
  const seconds = (timestamp - Date.now()) / 1000;
  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size) return rtf.format(Math.round(seconds / size), unit);
  }
  return 'just now';
}

/** Drops Markdown syntax from an excerpt so it reads like plain text. */
export function plainExcerpt(text: string): string {
  return withoutColors(text)
    // Colour tags cut off at either end of a search excerpt.
    .replace(/^[^<>]*?">|<\/?(?:mark|span)\b[^>]*>?/g, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, target: string, label?: string) => label ?? target)
    .replace(/(^|\s)#{1,6}\s/g, '$1')
    .replace(/(^|\s)[-*+] \[[ xX]\] /g, '$1')
    // Excerpts can start in the middle of a checkbox: "…x] Defeat Margit".
    .replace(/(^|[\s…])[ xX]?\] /g, '$1')
    .replace(/\*\*|__|~~|`/g, '')
    // List markers at line starts ("- Monday: pasta").
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, '')
    .replace(/\s+/g, ' ');
}

/** "340 KB", "12.3 MB", "1.25 GB"; zero stays "0 KB". */
export function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${bytes ? Math.max(1, Math.round(bytes / 1024)) : 0} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

/** "3 days 4 h", "2 h 15 min", "5 min". */
export function formatDuration(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d) return `${d} ${d === 1 ? 'day' : 'days'}${h ? ` ${h} h` : ''}`;
  if (h) return `${h} h${m ? ` ${m} min` : ''}`;
  return `${Math.max(m, 1)} min`;
}
