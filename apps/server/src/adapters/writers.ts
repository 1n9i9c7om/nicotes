import type { AdapterValue } from '@nicotes/shared';
import { round } from './sources.js';

/**
 * Where adapters write. A logbook is a page with a table, a row per day and a column per
 * value ("Solar (kWh)"), which the page view draws as charts. In the journal an adapter
 * keeps one line of its own (`**Weather:** …`), replaced when it runs again that day.
 */

const isRow = (line: string) => /^\s*\|/.test(line);
const isSeparator = (line: string) => /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(line);

/** The cells of a table line; `\|` stays part of a cell. */
export function cellsOf(line: string): string[] {
  const inner = line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '');
  return inner.split(/(?<!\\)\|/).map((c) => c.trim());
}

const lineOf = (cells: string[]) => `| ${cells.join(' | ')} |`;

/** The header of a value's column: "Solar (kWh)". */
export const columnOf = (value: AdapterValue) => (value.unit ? `${value.label} (${value.unit})` : value.label).replace(/\|/g, '\\|');

const cellOf = (value: AdapterValue) =>
  value.value === null ? '' : typeof value.value === 'number' ? String(round(value.value)) : value.value.replace(/\s*\n\s*/g, ' ').replace(/\|/g, '\\|');

/**
 * Sets the row of `date` in the page's logbook table (the first table whose first column is
 * "Date"), adding columns for new values; rows stay sorted by date. Everything else on the
 * page is kept as it is. Without such a table, one is added at the end.
 */
export function upsertLogbookRow(content: string, date: string, values: AdapterValue[]): string {
  const lines = content.split('\n');
  const start = lines.findIndex((line, i) => isRow(line) && isSeparator(lines[i + 1] ?? '') && cellsOf(line)[0]?.toLowerCase() === 'date');
  if (start < 0) {
    const header = ['Date', ...values.map(columnOf)];
    const table = [lineOf(header), lineOf(header.map(() => '---')), lineOf([date, ...values.map(cellOf)])].join('\n');
    const before = content.replace(/\s+$/, '');
    return `${before ? `${before}\n\n` : ''}${table}\n`;
  }

  let end = start + 2;
  while (end < lines.length && isRow(lines[end]!)) end++;
  const header = cellsOf(lines[start]!);
  const rows = lines.slice(start + 2, end).map(cellsOf);
  const column = (name: string) => header.findIndex((h) => h.toLowerCase() === name.toLowerCase());
  for (const value of values) if (column(columnOf(value)) < 0) header.push(columnOf(value));

  let row = rows.find((r) => r[0] === date);
  if (!row) {
    row = [date];
    const after = rows.findIndex((r) => (r[0] ?? '') > date);
    rows.splice(after < 0 ? rows.length : after, 0, row);
  }
  for (const value of values) row[column(columnOf(value))] = cellOf(value);
  const table = [header, header.map(() => '---'), ...rows.map((r) => header.map((_, i) => r[i] ?? ''))].map(lineOf);
  lines.splice(start, end - start, ...table);
  return lines.join('\n');
}

/** Sets the adapter's line in a journal note: `**<name>:** <text>`. */
export function setJournalLine(content: string, name: string, text: string): string {
  const prefix = `**${name}:**`;
  const line = `${prefix} ${text}`;
  const lines = content.split('\n');
  const at = lines.findIndex((l) => l.startsWith(prefix));
  if (at >= 0) {
    lines[at] = line;
    return lines.join('\n');
  }
  const before = content.replace(/\s+$/, '');
  return `${before ? `${before}\n\n` : ''}${line}\n`;
}
