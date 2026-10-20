/**
 * Small fuzzy matcher for titles: prefix > word start > substring > in-order letters.
 * Returns -1 when the query does not match at all.
 */
export function fuzzyScore(text: string, query: string): number {
  const t = text.toLowerCase();
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  if (t === q) return 100;
  if (t.startsWith(q)) return 80 - Math.min(t.length - q.length, 20) / 2;
  const wordStart = t.split(/[\s/_-]+/).some((w) => w.startsWith(q));
  if (wordStart) return 60;
  if (t.includes(q)) return 40;
  let i = 0;
  for (const ch of t) if (ch === q[i]) i++;
  return i === q.length ? 10 : -1;
}

/** Filters and ranks items by fuzzy score of `text(item)`. */
export function fuzzyFilter<T>(items: T[], query: string, text: (item: T) => string, limit = 20): T[] {
  if (!query.trim()) return items.slice(0, limit);
  return items
    .map((item) => ({ item, score: fuzzyScore(text(item), query) }))
    .filter((r) => r.score >= 0)
    .sort((a, b) => b.score - a.score || text(a.item).length - text(b.item).length)
    .slice(0, limit)
    .map((r) => r.item);
}
