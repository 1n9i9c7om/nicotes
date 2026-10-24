import { describe, expect, it } from 'vitest';
import { pageBlocks, type PageBlock } from './blocks';
import { guessLayout, specMatches } from './layout';
import { addItem, moveItem, removeItem, setAllChecked, setItemChecked, setItemText } from './listEdits';
import { findDurations, findServings, formatAmount, parseQuantity, scaleIngredient } from './recipe';

const list = (blocks: PageBlock[], n = 0) => blocks.filter((b) => b.kind === 'list')[n] as Extract<PageBlock, { kind: 'list' }>;

describe('pageBlocks', () => {
  it('splits a page into keyed blocks with line ranges', () => {
    const md = [
      '# Trip', //            0
      'Packing for the weekend.', // 1
      '', //                  2
      '## Clothes', //        3
      '- [ ] Socks', //       4
      '  - [x] Wool ones', // 5
      '- [x] Jacket', //      6
      '  rain-proof', //      7
      '', //                  8
      '1. Book train', //     9
      '2. Pack', //           10
      '```', //               11
      '- not a list', //      12
      '```', //               13
      '> quoted', //          14
    ].join('\n');
    const blocks = pageBlocks(md);
    expect(blocks.map((b) => [b.key, b.start, b.end])).toEqual([
      ['heading::0', 0, 0],
      ['paragraph:Trip:0', 1, 1],
      ['heading:Trip:0', 3, 3],
      ['list:Trip/Clothes:0', 4, 7],
      ['list:Trip/Clothes:1', 9, 10],
      ['code:Trip/Clothes:0', 11, 13],
      ['quote:Trip/Clothes:0', 14, 14],
    ]);
    const items = list(blocks).items;
    expect(items.map((i) => [i.line, i.end, i.depth, i.checked, i.text])).toEqual([
      [4, 5, 0, false, 'Socks'],
      [5, 5, 1, true, 'Wool ones'],
      [6, 7, 0, true, 'Jacket rain-proof'],
    ]);
    expect(list(blocks, 1).items.map((i) => [i.line, i.ordered, i.text])).toEqual([
      [9, true, 'Book train'],
      [10, true, 'Pack'],
    ]);
  });

  it('keeps keys stable when other parts of the page change', () => {
    const before = pageBlocks('## Ingredients\n- Flour\n\n## Steps\n1. Mix');
    const after = pageBlocks('Intro text.\n\n## Ingredients\n- Flour\n- Sugar\n\n## Steps\n1. Mix\n2. Bake');
    const key = (blocks: PageBlock[]) => blocks.filter((b) => b.kind === 'list').map((b) => b.key);
    expect(key(after)).toEqual(key(before));
  });
});

describe('list edits', () => {
  const md = '## Todo\n- [ ] One\n  - [ ] One a\n- [x] Two\n- Three\n\nAfter';
  const items = () => list(pageBlocks(md)).items;

  it('ticks, unticks and turns plain items into tasks', () => {
    expect(setItemChecked(md, items()[0]!, true)).toContain('- [x] One\n');
    expect(setItemChecked(md, items()[2]!, false)).toContain('- [ ] Two');
    expect(setItemChecked(md, items()[3]!, true)).toContain('- [x] Three');
    expect(setAllChecked(md, items(), false)).toBe('## Todo\n- [ ] One\n  - [ ] One a\n- [ ] Two\n- Three\n\nAfter');
  });

  it('edits, adds and removes items with their children', () => {
    expect(setItemText(md, items()[2]!, 'Deux')).toContain('- [x] Deux');
    expect(addItem(md, items()[0]!, 'New')).toBe('## Todo\n- [ ] One\n  - [ ] One a\n- [ ] New\n- [x] Two\n- Three\n\nAfter');
    expect(removeItem(md, items()[0]!)).toBe('## Todo\n- [x] Two\n- Three\n\nAfter');
    expect(addItem('1. Mix\n2. Bake', list(pageBlocks('1. Mix\n2. Bake')).items[1]!, 'Cool')).toBe('1. Mix\n2. Bake\n3. Cool');
  });

  it('moves items with their children, also into other lists and levels', () => {
    expect(moveItem(md, items()[0]!, items()[3]!, 'after')).toBe('## Todo\n- [x] Two\n- Three\n- [ ] One\n  - [ ] One a\n\nAfter');
    expect(moveItem(md, items()[3]!, items()[0]!, 'before')).toBe('## Todo\n- Three\n- [ ] One\n  - [ ] One a\n- [x] Two\n\nAfter');
    // Into the nested level: takes over the target's indentation.
    expect(moveItem(md, items()[2]!, items()[1]!, 'after')).toBe('## Todo\n- [ ] One\n  - [ ] One a\n  - [x] Two\n- Three\n\nAfter');
    expect(moveItem(md, items()[0]!, items()[1]!, 'after')).toBe(md); // not into itself
  });
});

describe('recipe helpers', () => {
  it('reads and scales amounts', () => {
    expect(parseQuantity('1 1/2 cups flour')).toEqual({ amount: 1.5, to: null, rest: ' cups flour' });
    expect(parseQuantity('½ TL Salz')).toMatchObject({ amount: 0.5 });
    expect(parseQuantity('2–3 Eier')).toMatchObject({ amount: 2, to: 3 });
    expect(parseQuantity('Salt to taste')).toBeNull();
    expect(scaleIngredient('200 g Mehl', 1.5)).toBe('300 g Mehl');
    expect(scaleIngredient('0,5 l Milch', 3, ',')).toBe('1½ l Milch');
    expect(scaleIngredient('2–3 eggs', 2)).toBe('4–6 eggs');
    expect(formatAmount(0.333)).toBe('⅓');
    expect(formatAmount(12.5)).toBe('12.5');
  });

  it('finds timers and servings', () => {
    expect(findDurations('Bake for 10–12 minutes, then rest 1 h. Add 200 g sugar.')).toEqual([
      { label: '10–12 minutes', seconds: 600 },
      { label: '1 h', seconds: 3600 },
    ]);
    expect(findDurations('30 Min. backen')).toEqual([{ label: '30 Min', seconds: 1800 }]);
    expect(findServings('Servings: 12 · Prep: 30 min')).toBe(12);
    expect(findServings('Zutaten für 4 Personen')).toBe(4);
    expect(findServings('**Servings:** 48 · **Prep:** 20 min')).toBe(48);
  });
});

describe('guessLayout', () => {
  it('recognises recipes, checklists, guides, stories and plain notes', () => {
    const recipe = guessLayout('Servings: 4\n\n## Zutaten\n- 200 g Mehl\n\n## Zubereitung\n1. Mischen\n2. Backen');
    expect(recipe).toMatchObject({ type: 'recipe', servings: 4, ingredients: ['list:Zutaten:0'], steps: ['list:Zubereitung:0'] });
    expect(recipe.confidence).toBeGreaterThanOrEqual(0.9);
    expect(guessLayout('- [ ] Milk\n- [x] Eggs\n- [ ] Bread')).toMatchObject({ type: 'checklist', lists: ['list::0'] });
    expect(guessLayout('## Steps\n1. Unplug\n2. Open the case\n3. Swap the disk')).toMatchObject({ type: 'steps' });
    const story = Array.from({ length: 5 }, (_, i) => `Paragraph ${i} of a long story that goes on and on. `.repeat(6)).join('\n\n');
    expect(guessLayout(story)).toMatchObject({ type: 'reader', language: 'en' });
    expect(guessLayout('Just a short note.')).toMatchObject({ type: 'document', confidence: 0.9 });
  });

  it('fills in a chosen layout as well as it can', () => {
    expect(guessLayout('- Flour\n- Sugar\n\nMix everything and bake.', [], 'recipe')).toMatchObject({
      type: 'recipe',
      ingredients: ['list::0'],
      steps: ['paragraph::0'],
    });
  });

  it('checks whether a spec still fits the page', () => {
    const spec = guessLayout('## Todo\n- [ ] A\n- [ ] B');
    expect(specMatches(spec, pageBlocks('## Todo\n- [ ] A\n- [x] B\n- [ ] C'))).toBe(true);
    expect(specMatches(spec, pageBlocks('## Done\n- [ ] A'))).toBe(false);
  });
});
