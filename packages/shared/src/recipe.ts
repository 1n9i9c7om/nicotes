/**
 * Reading quantities and times out of recipe text: scaling ingredient amounts to other
 * servings and offering timers for steps like "bake for 10–12 minutes".
 */

const VULGAR: Record<string, number> = { '½': 0.5, '⅓': 1 / 3, '⅔': 2 / 3, '¼': 0.25, '¾': 0.75, '⅕': 0.2, '⅛': 0.125 };
const NUMBER = String.raw`(?:\d+(?:[.,]\d+)?(?:\s+\d+/\d+|\s*[½⅓⅔¼¾⅕⅛])?|\d+/\d+|[½⅓⅔¼¾⅕⅛])`;
const LEADING = new RegExp(String.raw`^(${NUMBER})(?:\s*(?:-|–|to|bis)\s*(${NUMBER}))?`, 'i');

function parseNumber(text: string): number {
  const t = text.trim();
  const vulgar = Object.entries(VULGAR).find(([c]) => t.endsWith(c));
  if (vulgar) {
    const whole = t.slice(0, -1).trim();
    return (whole ? Number(whole) : 0) + vulgar[1];
  }
  const mixed = /^(\d+)\s+(\d+)\/(\d+)$/.exec(t);
  if (mixed) return Number(mixed[1]) + Number(mixed[2]) / Number(mixed[3]);
  const fraction = /^(\d+)\/(\d+)$/.exec(t);
  if (fraction) return Number(fraction[1]) / Number(fraction[2]);
  return Number(t.replace(',', '.'));
}

export interface Quantity {
  amount: number;
  /** Upper end of a range like "2–3". */
  to: number | null;
  /** The rest of the text after the number(s), e.g. " g flour". */
  rest: string;
}

/** The amount an ingredient line starts with, or null ("salt to taste"). */
export function parseQuantity(text: string): Quantity | null {
  const m = LEADING.exec(text.trim());
  if (!m) return null;
  const amount = parseNumber(m[1]!);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return { amount, to: m[2] ? parseNumber(m[2]) : null, rest: text.trim().slice(m[0].length) };
}

const FRACTIONS: [number, string][] = [
  [0.25, '¼'],
  [1 / 3, '⅓'],
  [0.5, '½'],
  [2 / 3, '⅔'],
  [0.75, '¾'],
];

/** A friendly amount: common fractions where they fit, else up to two decimals. */
export function formatAmount(value: number, decimal = '.'): string {
  const whole = Math.floor(value);
  const part = value - whole;
  const fraction = FRACTIONS.find(([f]) => Math.abs(part - f) < 0.02);
  if (fraction && value < 10) return `${whole || ''}${fraction[1]}`;
  if (part < 0.02 || part > 0.98) return String(Math.round(value));
  const rounded = value >= 100 ? Math.round(value) : Math.round(value * 100) / 100;
  return String(rounded).replace('.', decimal);
}

/** An ingredient line with its amount multiplied by `factor` (unchanged if it has none). */
export function scaleIngredient(text: string, factor: number, decimal = '.'): string {
  const q = parseQuantity(text);
  if (!q || factor === 1) return text.trim();
  const amount = formatAmount(q.amount * factor, decimal);
  const to = q.to === null ? '' : `–${formatAmount(q.to * factor, decimal)}`;
  return `${amount}${to}${q.rest}`;
}

const UNITS: [RegExp, number][] = [
  [/^(?:h|hrs?|hours?|std\.?|stunden?)$/i, 3600],
  [/^(?:min\.?|mins?|minutes?|minuten?|minute)$/i, 60],
  [/^(?:s|secs?|seconds?|sek\.?|sekunden?)$/i, 1],
];
const DURATION = new RegExp(String.raw`(${NUMBER})(?:\s*(?:-|–|to|bis)\s*(${NUMBER}))?\s*([a-zäöü.]+)`, 'gi');

export interface Duration {
  /** The text that names it, e.g. "10–12 minutes". */
  label: string;
  /** Seconds (the lower end of a range). */
  seconds: number;
}

/** Durations mentioned in a step, for timers. */
export function findDurations(text: string): Duration[] {
  const found: Duration[] = [];
  for (const m of text.matchAll(DURATION)) {
    const word = m[3]!;
    // "min." is an abbreviation, "minutes." ends a sentence.
    const unit = UNITS.find(([re]) => re.test(word) || re.test(word.replace(/\.$/, '')));
    if (!unit) continue;
    const seconds = Math.round(parseNumber(m[1]!) * unit[1]);
    // The label drops a full stop ("4 minutes." at a sentence end, or the "Min." abbreviation).
    if (seconds > 0 && seconds <= 48 * 3600) found.push({ label: m[0].trim().replace(/\.$/, ''), seconds });
  }
  return found;
}

export interface TableIngredient {
  name: string;
  /** The amount column ("½–1 cup (115–235 g)"), empty without one. */
  amount: string;
}

const NAME_COLUMN = /^(ingredients?|zutat(en)?|ingrédients?|ingredientes?|ingredienti|item|was)\b/i;
const AMOUNT_COLUMN = /(amount|quantity|qty|menge|measure|how much|typical|quantité|cantidad|quantità|hoeveelheid)/i;

/** Ingredients from a table: the ingredient and amount columns found by their headers. */
export function tableIngredients(header: string[], rows: string[][]): TableIngredient[] {
  const clean = (cell: string) => cell.replace(/[*_`]/g, '').trim();
  let name = header.findIndex((h) => NAME_COLUMN.test(clean(h)));
  if (name < 0) name = 0;
  let amount = header.findIndex((h, i) => i !== name && AMOUNT_COLUMN.test(clean(h)));
  if (amount < 0 && header.length > 1) amount = name === 0 ? 1 : 0;
  return rows
    .filter((row) => row[name]?.trim())
    .map((row) => ({ name: row[name]!.trim(), amount: amount >= 0 ? (row[amount] ?? '').trim() : '' }));
}

/** "Servings: 4", "serves 6", "Portionen: 4", "für 4 Personen", "12 servings". */
export function findServings(markdown: string): number | null {
  const text = markdown.replace(/[*_]/g, ''); // "**Servings:** 48"
  const m =
    /(?:servings|serves|yield|makes|portionen|personen|für)\s*:?\s*(\d{1,3})/i.exec(text) ??
    // "6–8 serving version" counts as 6.
    /(\d{1,3})(?:\s*[–-]\s*\d{1,3})?\s*(?:servings?|portions?|portionen|personen|stück|pieces)\b/i.exec(text);
  const n = m ? Number(m[1]) : NaN;
  return n > 0 && n < 1000 ? n : null;
}
