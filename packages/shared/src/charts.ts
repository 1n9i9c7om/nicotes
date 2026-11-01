import { tableRows } from './blocks';

/**
 * Tables of numbers as charts: the first column is the x axis (dates, or categories), every
 * mostly-numeric column a series. Logbooks written by adapters look like this, and so do
 * hand-kept ones (weight, meter readings, budgets).
 */

export interface ChartSeries {
  name: string;
  /** From the header ("Solar (kWh)") or the cells ("12.3 kWh"). */
  unit: string | null;
  values: (number | null)[];
}

export interface TableChart {
  xLabel: string;
  x: string[];
  /** "time": x are dates (a line per series); "category": anything else (bars). */
  kind: 'time' | 'category';
  series: ChartSeries[];
}

const strip = (cell: string) => cell.replace(/\*\*|__|`|~~/g, '').trim();

/** "12.3", "1,234.5", "1.234,5", "−4 °C", "45 %", "12.3 kWh" → the number; else null. */
export function parseNumber(cell: string): number | null {
  const m = /^([-+−]?)\s*(\d[\d\s'.,]*)/.exec(strip(cell).replace(/ /g, ' '));
  if (!m) return null;
  let digits = m[2]!.replace(/[\s']/g, '').replace(/[.,]$/, '');
  const lastDot = digits.lastIndexOf('.');
  const lastComma = digits.lastIndexOf(',');
  if (lastDot >= 0 && lastComma >= 0) {
    // Both: the later one is the decimal separator.
    digits = lastComma > lastDot ? digits.replace(/\./g, '').replace(',', '.') : digits.replace(/,/g, '');
  } else if (lastComma >= 0) {
    // "1,234" (thousands) vs "12,5" (decimal comma).
    digits = /^\d{1,3}(,\d{3})+$/.test(digits) ? digits.replace(/,/g, '') : digits.replace(',', '.');
  } else if ((digits.match(/\./g) ?? []).length > 1) {
    digits = digits.replace(/\./g, '');
  }
  const value = Number(digits);
  if (!Number.isFinite(value)) return null;
  return m[1] === '-' || m[1] === '−' ? -value : value;
}

/** The unit after a number in a cell ("12.3 kWh" → "kWh"), if any. */
const cellUnit = (cell: string) => /^[-+−]?\s*\d[\d\s'.,]*\s*([^\d\s|][^|]{0,11})$/.exec(strip(cell))?.[1]?.trim() ?? null;

const DATE = /^(\d{4}-\d{2}(-\d{2})?|\d{1,2}\.\d{1,2}\.(\d{2}|\d{4})|\d{1,2}\/\d{1,2}\/\d{2,4})\b/;

/** A table block's chart, or null when it has no numeric column or fewer than two rows. */
export function tableChart(text: string): TableChart | null {
  const { header, rows } = tableRows(text);
  if (header.length < 2 || rows.length < 2) return null;
  const x = rows.map((r) => strip(r[0] ?? ''));
  const series: ChartSeries[] = [];
  for (let col = 1; col < header.length; col++) {
    const cells = rows.map((r) => r[col] ?? '').filter((c) => strip(c) && !/^[-–—]$/.test(strip(c)));
    const numbers = cells.map(parseNumber);
    const count = numbers.filter((n) => n !== null).length;
    if (count < 2 || count < cells.length * 0.6) continue;
    const head = strip(header[col]!);
    const unitInHead = /^(.*?)\s*[([]\s*([^)\]]{1,12})\s*[)\]]$/.exec(head);
    const units = [...new Set(cells.map(cellUnit).filter(Boolean))];
    series.push({
      name: unitInHead ? unitInHead[1]! : head || `Column ${col + 1}`,
      unit: unitInHead ? unitInHead[2]! : units.length === 1 ? units[0]! : null,
      values: rows.map((r) => (strip(r[col] ?? '') ? parseNumber(r[col]!) : null)),
    });
  }
  if (!series.length) return null;
  const dated = x.filter((v) => DATE.test(v)).length;
  return { xLabel: strip(header[0]!), x, kind: dated >= x.length * 0.8 ? 'time' : 'category', series };
}
