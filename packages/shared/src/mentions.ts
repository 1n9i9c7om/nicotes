import { DUE_TOKEN } from './tasks';

/**
 * Unlinked mentions: page titles written as plain text instead of as `[[links]]`. Shared by
 * the server (finding them) and the web app (linking them on the open page).
 *
 * A mention matches a title's words in order, case-insensitively and as whole words, with the
 * same punctuation between them ("Hollow Knight: Tips" but not "Hollow Knight. Tips"). One-word
 * titles must also match the case of their first letter, so a page "Notes" doesn't claim every
 * "notes". Code, links, URLs, HTML, headings and due dates are never matched.
 */

export interface TextRange {
  start: number;
  end: number;
}

export interface Mention extends TextRange {
  /** The text as written. */
  text: string;
}

export interface MentionPattern {
  words: string[];
  /** Normalised separators between the words. */
  gaps: string[];
  /** For one-word titles: the first character, which must match exactly. */
  first: string | null;
}

/** Another page mentions this one without linking it. */
export interface IncomingMention {
  id: string;
  notebookId: string;
  title: string;
  /** Number of unlinked mentions in that page. */
  count: number;
  /** The line of the first mention, with search match markers around it. */
  excerpt: string;
}

/** This page mentions another page without linking it. */
export interface OutgoingMention {
  id: string;
  notebookId: string;
  title: string;
  /** What to write between the brackets. */
  target: string;
  /** The first mention as written. */
  text: string;
  count: number;
}

export interface MentionsResult {
  incoming: IncomingMention[];
  outgoing: OutgoingMention[];
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const HEADING = /^ {0,3}#{1,6}(\s|$)/;
const SKIP_INLINE = [
  /(`+)[^`\n]*?\1/g, // inline code
  /!?\[\[[^\]\n]*\]\]/g, // wikilinks and embeds
  /!?\[[^\]\n]*\]\([^)\n]*\)/g, // Markdown links and images
  /<[^>\n]+>/g, // HTML and autolinks
  /\bhttps?:\/\/\S+/g, // bare URLs
  DUE_TOKEN,
];
const WORD = /[\p{L}\p{N}]+/gu;

interface Word extends TextRange {
  text: string;
}

const wordsOf = (text: string): Word[] =>
  [...text.matchAll(WORD)].map((m) => ({ text: m[0].toLowerCase(), start: m.index, end: m.index + m[0].length }));

const gapKey = (gap: string) => gap.toLowerCase().replace(/\s+/g, ' ');

/** Character ranges where nothing may be linked, sorted and merged. */
export function protectedRanges(markdown: string): TextRange[] {
  const ranges: TextRange[] = [];
  let offset = 0;
  let fence: { marker: string; start: number } | null = null;
  for (const line of markdown.split('\n')) {
    const marker = FENCE.exec(line)?.[1];
    const end = offset + line.length;
    if (fence) {
      if (marker && marker[0] === fence.marker[0] && marker.length >= fence.marker.length) {
        ranges.push({ start: fence.start, end });
        fence = null;
      }
    } else if (marker) {
      fence = { marker, start: offset };
    } else if (HEADING.test(line)) {
      ranges.push({ start: offset, end });
    }
    offset = end + 1;
  }
  if (fence) ranges.push({ start: fence.start, end: markdown.length });
  for (const re of SKIP_INLINE) {
    for (const m of markdown.matchAll(re)) ranges.push({ start: m.index, end: m.index + m[0].length });
  }
  ranges.sort((a, b) => a.start - b.start);
  const merged: TextRange[] = [];
  for (const r of ranges) {
    const last = merged.at(-1);
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
    else merged.push({ ...r });
  }
  return merged;
}

/** How a title is matched, or null if it makes a poor mention (too short, only a number…). */
export function mentionPattern(title: string): MentionPattern | null {
  const t = title.trim();
  if (/[[\]|]/.test(t)) return null; // could not be written as a link target
  const words = wordsOf(t);
  if (!words.length || words[0]!.start !== 0 || words.at(-1)!.end !== t.length) return null;
  if (words.reduce((n, w) => n + w.text.length, 0) < 3) return null;
  // Numbers and dates are no topic: "2026" or a daily note's date mostly appear as metadata.
  if (!/\p{L}/u.test(t)) return null;
  return {
    words: words.map((w) => w.text),
    gaps: words.slice(1).map((w, i) => gapKey(t.slice(words[i]!.end, w.start))),
    first: words.length === 1 ? t[0]! : null,
  };
}

/**
 * Unlinked mentions of each pattern in `markdown`, in document order. Where mentions of two
 * titles overlap ("Elden Ring" inside "Elden Ring Builds"), only the longer one counts.
 */
export function findMentions(markdown: string, patterns: (MentionPattern | null)[]): Mention[][] {
  const blocked = protectedRanges(markdown);
  const isBlocked = (start: number, end: number) => blocked.some((r) => start < r.end && end > r.start);
  const words = wordsOf(markdown);
  const byFirst = new Map<string, number[]>();
  patterns.forEach((p, i) => {
    if (p) byFirst.set(p.words[0]!, [...(byFirst.get(p.words[0]!) ?? []), i]);
  });

  const found: { pattern: number; mention: Mention }[] = [];
  words.forEach((word, i) => {
    for (const pi of byFirst.get(word.text) ?? []) {
      const p = patterns[pi]!;
      const last = words[i + p.words.length - 1];
      if (!last) continue;
      let ok = true;
      for (let k = 1; k < p.words.length && ok; k++) {
        const gap = markdown.slice(words[i + k - 1]!.end, words[i + k]!.start);
        ok = words[i + k]!.text === p.words[k] && !gap.includes('\n') && gapKey(gap) === p.gaps[k - 1];
      }
      if (!ok || (p.first && markdown[word.start] !== p.first) || isBlocked(word.start, last.end)) continue;
      found.push({ pattern: pi, mention: { start: word.start, end: last.end, text: markdown.slice(word.start, last.end) } });
    }
  });

  const result: Mention[][] = patterns.map(() => []);
  for (const f of found) {
    const m = f.mention;
    const covered = found.some(
      (o) => o !== f && o.mention.start <= m.start && o.mention.end >= m.end && o.mention.end - o.mention.start > m.end - m.start,
    );
    if (!covered) result[f.pattern]!.push(m);
  }
  return result;
}

/** Wraps a mention in a wikilink to `target`, keeping the text as written. */
export function linkMention(markdown: string, mention: TextRange, target: string): string {
  const text = markdown.slice(mention.start, mention.end);
  const link = text.toLowerCase() === target.trim().toLowerCase() ? `[[${text}]]` : `[[${target}|${text}]]`;
  return markdown.slice(0, mention.start) + link + markdown.slice(mention.end);
}

/**
 * First occurrence of an arbitrary phrase (e.g. one an AI suggested), case-insensitive and as
 * whole words, outside code, links and headings. Null if there is none.
 */
export function findPhrase(markdown: string, phrase: string): Mention | null {
  const needle = phrase.trim();
  if (!needle) return null;
  const blocked = protectedRanges(markdown);
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  const re = new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'giu');
  for (const m of markdown.matchAll(re)) {
    const end = m.index + m[0].length;
    if (!m[0].includes('\n') && !blocked.some((r) => m.index < r.end && end > r.start)) {
      return { start: m.index, end, text: m[0] };
    }
  }
  return null;
}

/** Links the first unlinked mention of `title`; null if there is none. */
export function linkFirstMention(markdown: string, title: string, target: string): string | null {
  const first = findMentions(markdown, [mentionPattern(title)])[0]![0];
  return first ? linkMention(markdown, first, target) : null;
}
