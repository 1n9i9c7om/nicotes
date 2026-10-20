import { describe, expect, it } from 'vitest';
import type { AskSource } from '@nicotes/shared';
import { citedNumbers, renumberCitations } from './ask';
import { parseBlocks } from './markdown';

const source = (n: number): AskSource => ({ n, pageId: `p${n}`, notebookId: 'nb', title: `T${n}`, heading: '', excerpt: '' });

describe('citations', () => {
  it('lists cited numbers in order of first use', () => {
    expect(citedNumbers('A [4]. B [3, 4][7]. C [[Link]] and [x](y).')).toEqual([4, 3, 7]);
  });

  it('renumbers citations for a saved note', () => {
    const { answer, list } = renumberCitations('A [4]. B [3, 4][9].', [source(4), source(3)], (s) => s.title);
    expect(answer).toBe('A [1]. B [2][1].');
    expect(list).toEqual(['1. T4', '2. T3']);
  });
});

describe('parseBlocks', () => {
  it('splits answers into headings, paragraphs, lists, quotes and code', () => {
    const md = '## Plan\nFirst line\ncontinues.\n\n- one\n  - nested\n- two\n1. first\n\n> quoted\n\n```\ncode\n```';
    expect(parseBlocks(md)).toEqual([
      { kind: 'heading', level: 2, text: 'Plan' },
      { kind: 'paragraph', text: 'First line continues.' },
      { kind: 'list', ordered: false, items: [{ depth: 0, text: 'one' }, { depth: 1, text: 'nested' }, { depth: 0, text: 'two' }] },
      { kind: 'list', ordered: true, items: [{ depth: 0, text: 'first' }] },
      { kind: 'quote', text: 'quoted' },
      { kind: 'code', text: 'code' },
    ]);
  });
});
