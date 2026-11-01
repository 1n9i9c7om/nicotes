import { describe, expect, it } from 'vitest';
import { findMentions, findPhrase, linkFirstMention, mentionPattern } from './mentions';
import { appendSeeAlso } from './sections';
import { appendTask, parseTasks, updateTaskLine } from './tasks';

const texts = (md: string, title: string) => findMentions(md, [mentionPattern(title)])[0]!.map((m) => m.text);

describe('findMentions', () => {
  it('matches whole words case-insensitively with the same punctuation', () => {
    const md = 'My strength build works. Strength builds do not count. Hollow Knight: Tips, Hollow Knight. Tips';
    expect(texts(md, 'Strength build')).toEqual(['strength build']);
    expect(texts(md, 'Hollow Knight: Tips')).toEqual(['Hollow Knight: Tips']);
  });

  it('ignores code, links, URLs, headings and due dates', () => {
    const md = [
      '# Malenia notes',
      'Beat [[Malenia]] and [Malenia](https://x.test/Malenia) `Malenia`',
      'https://wiki.test/Malenia <span title="Malenia">',
      '```',
      'Malenia',
      '```',
      '- [ ] Retry Malenia 📅 2026-10-20',
    ].join('\n');
    expect(texts(md, 'Malenia')).toEqual(['Malenia']);
    expect(texts('- [ ] Plan 📅 2026-10-20 Retry', 'Retry')).toEqual(['Retry']);
    expect(findMentions('Due 📅 2026-10-20', [{ words: ['2026', '10', '20'], gaps: ['-', '-'], first: null }])[0]).toEqual([]);
  });

  it('requires the case of the first letter for one-word titles', () => {
    expect(texts('The bosses and the Bosses page', 'Bosses')).toEqual(['Bosses']);
    expect(texts('Bake an apfelkuchen', 'Apfelkuchen')).toEqual([]);
  });

  it('rejects titles that make poor mentions', () => {
    for (const title of ['AI', '2026', '2026-10-20', 'C++', '  ', 'a|b']) expect(mentionPattern(title)).toBeNull();
    expect(mentionPattern('Q3 plan')).not.toBeNull();
  });

  it('prefers the longer of two overlapping titles', () => {
    const [short, long] = findMentions('Read Elden Ring Builds first. Elden Ring is great.', [
      mentionPattern('Elden Ring'),
      mentionPattern('Elden Ring Builds'),
    ]);
    expect(short!.map((m) => m.start)).toEqual([30]);
    expect(long!.map((m) => m.text)).toEqual(['Elden Ring Builds']);
  });

  it('finds arbitrary phrases outside protected text', () => {
    const md = '# Main bus\nSee `main bus` and [[Main bus]]. Build a main\nbus. A good Main Bus design.';
    expect(findPhrase(md, 'main bus')).toMatchObject({ text: 'Main Bus', start: md.indexOf('Main Bus design') });
    expect(findPhrase('mainbus', 'main bus')).toBeNull();
    expect(findPhrase('Cost (USD) here', 'Cost (USD)')).toMatchObject({ text: 'Cost (USD)' });
  });

  it('links the first mention, keeping the text as written', () => {
    expect(linkFirstMention('I use a strength build. Strength build!', 'Strength build', 'Strength build')).toBe(
      'I use a [[strength build]]. Strength build!',
    );
    expect(linkFirstMention('See Builds.', 'Builds', 'Elden Ring/Builds')).toBe('See [[Elden Ring/Builds|Builds]].');
    expect(linkFirstMention('Nothing here', 'Builds', 'Builds')).toBeNull();
  });
});

describe('appendSeeAlso', () => {
  it('adds to an existing section or creates one', () => {
    expect(appendSeeAlso('Text', 'Bread')).toBe('Text\n\n## See also\n\n- [[Bread]]');
    expect(appendSeeAlso('Text\n\n## Related\n- [[A]]\n\n## Notes', 'B')).toBe('Text\n\n## Related\n- [[A]]\n- [[B]]\n\n## Notes');
    expect(appendSeeAlso('', 'B')).toBe('## See also\n\n- [[B]]');
  });
});

describe('tasks', () => {
  it('parses tasks with headings, nesting and due dates outside code', () => {
    const md = [
      '## Shopping',
      '- [ ] Flour 📅 2026-10-25',
      '  - [x] Eggs due:2026-10-21',
      '1. [ ] Call @2026-10-22 mom',
      '```',
      '- [ ] not a task',
      '```',
      '- [] not a task either',
    ].join('\n');
    expect(parseTasks(md)).toEqual([
      { line: 1, raw: '- [ ] Flour 📅 2026-10-25', text: 'Flour', done: false, due: '2026-10-25', remind: null, heading: 'Shopping', depth: 0 },
      { line: 2, raw: '  - [x] Eggs due:2026-10-21', text: 'Eggs', done: true, due: '2026-10-21', remind: null, heading: 'Shopping', depth: 1 },
      { line: 3, raw: '1. [ ] Call @2026-10-22 mom', text: 'Call mom', done: false, due: '2026-10-22', remind: null, heading: 'Shopping', depth: 0 },
    ]);
  });

  it('reads reminder times on the due date or on a day of their own', () => {
    const [onDue, ownDay, noDate, late] = parseTasks(
      [
        '- [ ] Call mum ⏰ 9:30 📅 2026-11-04',
        '- [ ] Pay rent 📅 2026-11-30 ⏰ 2026-11-28 18:00',
        '- [ ] Stretch ⏰ 07:00',
        '- [ ] Not a time ⏰ 24:00 📅 2026-11-04',
      ].join('\n'),
    );
    expect(onDue).toMatchObject({ text: 'Call mum', due: '2026-11-04', remind: '2026-11-04T09:30' });
    expect(ownDay).toMatchObject({ text: 'Pay rent', due: '2026-11-30', remind: '2026-11-28T18:00' });
    expect(noDate).toMatchObject({ text: 'Stretch', remind: null });
    expect(late).toMatchObject({ remind: null });
    // Setting another due date keeps the reminder.
    expect(updateTaskLine('- [ ] Call mum ⏰ 9:30 📅 2026-11-04', { due: '2026-11-05' })).toBe('- [ ] Call mum ⏰ 9:30 📅 2026-11-05');
  });

  it('adds tasks to a placeholder, a tasks section or the end of the page', () => {
    expect(appendTask('## Notes\n\n\n## Tasks\n\n- [ ] ', 'Buy flour', '2026-10-25')).toBe(
      '## Notes\n\n\n## Tasks\n\n- [ ] Buy flour 📅 2026-10-25',
    );
    expect(appendTask('## Todo\n- [x] Old\n- [ ] Two\n\n## Notes\ntext', 'New')).toBe(
      '## Todo\n- [x] Old\n- [ ] Two\n- [ ] New\n\n## Notes\ntext',
    );
    expect(appendTask('# Aufgaben\n\n## Later', 'Neu')).toBe('# Aufgaben\n\n- [ ] Neu\n\n## Later');
    expect(appendTask('Some text\n\n', 'New')).toBe('Some text\n\n- [ ] New');
    expect(appendTask('- [ ] One', 'Two')).toBe('- [ ] One\n- [ ] Two');
    expect(parseTasks('- [ ] \n- [ ] Real')).toHaveLength(1);
  });

  it('rewrites the checkbox and the due date', () => {
    expect(updateTaskLine('  - [ ] Flour due:2026-10-25', { done: true })).toBe('  - [x] Flour due:2026-10-25');
    expect(updateTaskLine('- [x] Flour due:2026-10-25', { done: false, due: '2026-11-01' })).toBe('- [ ] Flour 📅 2026-11-01');
    expect(updateTaskLine('* [ ] Flour 📅 2026-10-25 later', { due: null })).toBe('* [ ] Flour later');
  });
});
