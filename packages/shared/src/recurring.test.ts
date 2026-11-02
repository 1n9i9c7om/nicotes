import { describe, expect, it } from 'vitest';
import { parseTasks } from './tasks';
import { setItemChecked } from './listEdits';
import { pageBlocks } from './blocks';
import { nextOccurrence, parseRecurRule, tickTaskLine } from './recurring';

const next = (rule: string, from: string) => nextOccurrence(parseRecurRule(rule)!, from);

describe('recurring tasks', () => {
  it('reads repeat rules', () => {
    expect(parseRecurRule('every 2 weeks when done')).toEqual({ unit: 'week', every: 2, weekdays: [], monthDay: null, whenDone: true });
    expect(parseRecurRule('Every Monday and Thursday')?.weekdays).toEqual([1, 4]);
    expect(parseRecurRule('weekly')?.unit).toBe('week');
    expect(parseRecurRule('every month on the last')?.monthDay).toBe(-1);
    for (const nonsense of ['every', 'sometimes', 'every 0 days', 'every month on the 32nd', 'every funday']) expect(parseRecurRule(nonsense)).toBeNull();
  });

  it('finds the next date', () => {
    expect(next('every day', '2026-11-02')).toBe('2026-11-03');
    expect(next('every 2 weeks', '2026-11-02')).toBe('2026-11-16');
    // 2026-11-06 is a Friday.
    expect(next('every weekday', '2026-11-06')).toBe('2026-11-09');
    expect(next('every monday, thursday', '2026-11-03')).toBe('2026-11-05');
    expect(next('every 2 weeks on monday', '2026-11-02')).toBe('2026-11-16');
    expect(next('every month', '2026-01-31')).toBe('2026-02-28');
    expect(next('every month on the 15th', '2026-11-20')).toBe('2026-12-15');
    expect(next('every month on the last', '2026-01-31')).toBe('2026-02-28');
    expect(next('every year', '2028-02-29')).toBe('2029-02-28');
  });

  it('adds the next occurrence above a ticked-off task, moving its dates', () => {
    const lines = ['## Home', '  - [ ] Water **plants** 🔁 every week 📅 2026-11-02 ⏰ 2026-11-01 18:00', '- [ ] Call mom'];
    expect(tickTaskLine(lines, 1, '2026-11-04')).toEqual([
      '## Home',
      '  - [ ] Water **plants** 🔁 every week 📅 2026-11-09 ⏰ 2026-11-08 18:00',
      '  - [x] Water **plants** 🔁 every week 📅 2026-11-02 ⏰ 2026-11-01 18:00',
      '- [ ] Call mom',
    ]);
    // "When done" and undated tasks count from today.
    expect(tickTaskLine(['- [ ] Haircut 🔁 every 6 weeks when done 📅 2026-10-01'], 0, '2026-11-04')[0]).toBe('- [ ] Haircut 🔁 every 6 weeks when done 📅 2026-12-16');
    expect(tickTaskLine(['- [ ] Stretch 🔁 every day'], 0, '2026-11-04')).toEqual(['- [ ] Stretch 🔁 every day 📅 2026-11-05', '- [x] Stretch 🔁 every day']);
    expect(tickTaskLine(['- [ ] Once 📅 2026-11-02'], 0, '2026-11-04')).toEqual(['- [x] Once 📅 2026-11-02']);
    expect(tickTaskLine(['- [x] Old 🔁 every day'], 0, '2026-11-04')).toEqual(['- [x] Old 🔁 every day']);
  });

  it('keeps the rule out of the task text, and repeats in the views', () => {
    const md = '- [ ] Water plants 🔁 every week 📅 2026-11-02';
    expect(parseTasks(md)[0]).toMatchObject({ text: 'Water plants', repeat: 'every week', due: '2026-11-02' });
    const item = pageBlocks(md).find((b) => b.kind === 'list')!;
    const list = item as Extract<typeof item, { items: unknown[] }>;
    expect(setItemChecked(md, list.items[0]!, true, '2026-11-03')).toBe('- [ ] Water plants 🔁 every week 📅 2026-11-09\n- [x] Water plants 🔁 every week 📅 2026-11-02');
  });
});
