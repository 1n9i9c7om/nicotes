import { describe, expect, it } from 'vitest';
import { applyHunks, diffHunks, diffSegments } from './diff';

const before = ['# Shopping', '', '- apples', '- pears', '- milk', '', 'Notes', 'end'].join('\n');
const after = ['# Shopping list', '', '- apples', '- milk', '- bread', '', 'Notes', 'end', 'PS'].join('\n');

describe('diffHunks / applyHunks', () => {
  it('groups contiguous changes into hunks', () => {
    const hunks = diffHunks(before, after);
    expect(hunks.map(({ start, removed, added }) => ({ start, removed, added }))).toEqual([
      { start: 0, removed: ['# Shopping'], added: ['# Shopping list'] },
      { start: 3, removed: ['- pears'], added: [] },
      { start: 5, removed: [], added: ['- bread'] },
      { start: 8, removed: [], added: ['PS'] },
    ]);
  });

  it('gives back both texts exactly with all or no hunks', () => {
    const hunks = diffHunks(before, after);
    expect(applyHunks(before, hunks, hunks.map((h) => h.id))).toBe(after);
    expect(applyHunks(before, hunks, [])).toBe(before);
  });

  it('applies only the accepted hunks', () => {
    const hunks = diffHunks(before, after);
    expect(applyHunks(before, hunks, [0, 3])).toBe(
      ['# Shopping list', '', '- apples', '- pears', '- milk', '', 'Notes', 'end', 'PS'].join('\n'),
    );
    expect(applyHunks(before, hunks, [1, 2])).toBe(
      ['# Shopping', '', '- apples', '- milk', '- bread', '', 'Notes', 'end'].join('\n'),
    );
  });

  it('round-trips every subset for texts with empty and trailing lines', () => {
    const a = 'one\n\ntwo\nthree\n';
    const b = '\none\ntwo\n3\nfour\n\n';
    const hunks = diffHunks(a, b);
    for (let mask = 0; mask < 1 << hunks.length; mask++) {
      const accepted = hunks.filter((h) => mask & (1 << h.id)).map((h) => h.id);
      const result = applyHunks(a, hunks, accepted);
      // Applying the rest on top of a partial result reaches the target.
      const rest = diffHunks(result, b);
      expect(applyHunks(result, rest, rest.map((h) => h.id))).toBe(b);
    }
    expect(applyHunks(a, hunks, hunks.map((h) => h.id))).toBe(b);
  });

  it('finds nothing for identical texts', () => {
    expect(diffHunks(before, before)).toEqual([]);
  });
});

describe('diffSegments', () => {
  it('keeps context around hunks and collapses the rest', () => {
    const text = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n');
    const changed = text.replace('line 10', 'line ten');
    const segments = diffSegments(text, diffHunks(text, changed), 2);
    expect(segments).toEqual([
      { type: 'gap', count: 7 },
      { type: 'same', lines: ['line 8', 'line 9'] },
      { type: 'hunk', hunk: { id: 0, start: 9, removed: ['line 10'], added: ['line ten'] } },
      { type: 'same', lines: ['line 11', 'line 12'] },
      { type: 'gap', count: 8 },
    ]);
  });

  it('keeps context before an insertion at the very end', () => {
    const text = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n');
    const segments = diffSegments(text, diffHunks(text, `${text}\nline 11`), 2);
    expect(segments).toEqual([
      { type: 'gap', count: 8 },
      { type: 'same', lines: ['line 9', 'line 10'] },
      { type: 'hunk', hunk: { id: 0, start: 10, removed: [], added: ['line 11'] } },
    ]);
  });

  it('does not collapse short stretches', () => {
    const segments = diffSegments('a\nb\nc', diffHunks('a\nb\nc', 'a\nB\nc'), 3);
    expect(segments.map((s) => s.type)).toEqual(['same', 'hunk', 'same']);
  });
});
