import type { AskSource } from '@nicotes/shared';

export const CITATION = /\[(\d+(?:\s*,\s*\d+)*)\]/g;

/** Citation numbers used in an answer, in order of first use. */
export function citedNumbers(answer: string): number[] {
  const seen = new Set<number>();
  for (const m of answer.matchAll(CITATION)) for (const n of m[1]!.split(',')) seen.add(Number(n.trim()));
  return [...seen];
}

/**
 * Renumbers an answer's citations to 1…n following `sources` (the cited ones, in order of use)
 * and returns the matching numbered source list.
 */
export function renumberCitations(answer: string, sources: AskSource[], label: (s: AskSource) => string) {
  const number = new Map(sources.map((s, i) => [s.n, i + 1]));
  const renumbered = answer.replace(CITATION, (_m, list: string) =>
    list
      .split(',')
      .map((n) => number.get(Number(n.trim())))
      .filter((n): n is number => n !== undefined)
      .map((n) => `[${n}]`)
      .join(''),
  );
  return { answer: renumbered, list: sources.map((s, i) => `${i + 1}. ${label(s)}`) };
}
