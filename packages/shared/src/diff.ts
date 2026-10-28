import { diffArrays } from 'diff';

// ---------- Line diffs with hunks that can be accepted one by one ----------

/** One contiguous change: lines removed from `before` and lines put in their place. */
export interface Hunk {
  /** Position in the hunk list; stable for the same pair of texts. */
  id: number;
  /** Index of the first affected line in `before` (where an insertion goes). */
  start: number;
  removed: string[];
  added: string[];
}

export type DiffSegment =
  | { type: 'same'; lines: string[] }
  | { type: 'gap'; count: number }
  | { type: 'hunk'; hunk: Hunk };

const lines = (text: string) => text.split('\n');

/** The changes from `before` to `after`, line by line, grouped into hunks. */
export function diffHunks(before: string, after: string): Hunk[] {
  const hunks: Hunk[] = [];
  let line = 0;
  let open: Hunk | null = null;
  for (const part of diffArrays(lines(before), lines(after))) {
    if (!part.added && !part.removed) {
      open = null;
      line += part.count ?? part.value.length;
      continue;
    }
    if (!open) {
      open = { id: hunks.length, start: line, removed: [], added: [] };
      hunks.push(open);
    }
    if (part.added) open.added.push(...part.value);
    else {
      open.removed.push(...part.value);
      line += part.value.length;
    }
  }
  return hunks;
}

/**
 * Applies the accepted hunks to `before` and leaves the others out. All hunks give `after`
 * back exactly; none gives `before`.
 */
export function applyHunks(before: string, hunks: Hunk[], accepted: Iterable<number>): string {
  const take = new Set(accepted);
  const source = lines(before);
  const out: string[] = [];
  let line = 0;
  for (const hunk of [...hunks].sort((a, b) => a.start - b.start)) {
    out.push(...source.slice(line, hunk.start));
    out.push(...(take.has(hunk.id) ? hunk.added : hunk.removed));
    line = hunk.start + hunk.removed.length;
  }
  out.push(...source.slice(line));
  return out.join('\n');
}

/**
 * The diff for display: hunks with up to `context` unchanged lines around them, longer
 * unchanged stretches collapsed into gaps.
 */
export function diffSegments(before: string, hunks: Hunk[], context = 3): DiffSegment[] {
  const source = lines(before);
  const segments: DiffSegment[] = [];
  // Only the stretches before the first and after the last hunk lack a neighbour on one side.
  const same = (from: number, to: number, leading: boolean, trailing: boolean) => {
    if (to <= from) return;
    const stretch = source.slice(from, to);
    const keepHead = leading ? 0 : context;
    const keepTail = trailing ? 0 : context;
    if (stretch.length <= keepHead + keepTail + 1) {
      segments.push({ type: 'same', lines: stretch });
      return;
    }
    if (keepHead) segments.push({ type: 'same', lines: stretch.slice(0, keepHead) });
    segments.push({ type: 'gap', count: stretch.length - keepHead - keepTail });
    if (keepTail) segments.push({ type: 'same', lines: stretch.slice(-keepTail) });
  };
  let line = 0;
  for (const [i, hunk] of [...hunks].sort((a, b) => a.start - b.start).entries()) {
    same(line, hunk.start, i === 0, false);
    segments.push({ type: 'hunk', hunk });
    line = hunk.start + hunk.removed.length;
  }
  same(line, source.length, hunks.length === 0, true);
  return segments;
}
