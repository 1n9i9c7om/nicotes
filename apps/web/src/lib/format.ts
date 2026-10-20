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
  return text
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
