import { describe, expect, it } from 'vitest';
import { normalizeTag } from './tags';
import {
  buildLinkContext,
  extractWikilinks,
  linkTargetFor,
  mapWikilinks,
  resolveWikilink,
  retarget,
  type LinkablePage,
} from './wikilinks';

describe('extractWikilinks', () => {
  it('finds links with labels and ignores code and escaped brackets', () => {
    const md = [
      'See [[Elden Ring]] and [[Games/Factorio|the factory]].',
      'Inline `[[NotALink]]` and escaped \\[[Nope]].',
      '```',
      '[[InFence]]',
      '```',
      'Twice: [[Elden Ring]]',
    ].join('\n');
    expect(extractWikilinks(md)).toEqual([
      { target: 'Elden Ring', label: null, section: null },
      { target: 'Games/Factorio', label: 'the factory', section: null },
    ]);
  });

  it('rewrites targets but keeps labels and code untouched', () => {
    const md = '[[Old]] [[Old|label]] `[[Old]]`';
    expect(mapWikilinks(md, (ref) => (ref.target === 'Old' ? 'New' : null))).toBe('[[New]] [[New|label]] `[[Old]]`');
  });
});

describe('resolution', () => {
  let t = 0;
  const page = (id: string, title: string, notebookId = 'games', parentId: string | null = null): LinkablePage => ({
    id,
    title,
    notebookId,
    parentId,
    createdAt: ++t,
  });
  const pages = [
    page('elden', 'Elden Ring'),
    page('elden-builds', 'Builds', 'games', 'elden'),
    page('factorio', 'Factorio'),
    page('factorio-builds', 'Builds', 'games', 'factorio'),
    page('work-builds', 'Builds', 'work'),
  ];
  const ctx = buildLinkContext(pages, [
    { id: 'games', title: 'Games' },
    { id: 'work', title: 'Work' },
  ]);

  it('resolves plain and qualified titles, case-insensitively', () => {
    expect(resolveWikilink(ctx, 'elden ring')?.id).toBe('elden');
    expect(resolveWikilink(ctx, 'Factorio/Builds')?.id).toBe('factorio-builds');
    expect(resolveWikilink(ctx, 'Games/Elden Ring/Builds')?.id).toBe('elden-builds');
    expect(resolveWikilink(ctx, 'Work/Builds')?.id).toBe('work-builds');
    expect(resolveWikilink(ctx, 'Missing')).toBeNull();
  });

  it('prefers the linking notebook, then the oldest page', () => {
    expect(resolveWikilink(ctx, 'Builds', 'work')?.id).toBe('work-builds');
    expect(resolveWikilink(ctx, 'Builds', 'games')?.id).toBe('elden-builds');
  });

  it('builds the shortest unambiguous target', () => {
    expect(linkTargetFor(ctx, ctx.pages.get('elden')!)).toBe('Elden Ring');
    expect(linkTargetFor(ctx, ctx.pages.get('factorio-builds')!)).toBe('Factorio/Builds');
    expect(linkTargetFor(ctx, ctx.pages.get('work-builds')!)).toBe('Work/Builds');
  });

  it('retargets with the same qualification depth', () => {
    const renamed = buildLinkContext(
      pages.map((p) => (p.id === 'factorio' ? { ...p, title: 'Factorio 2' } : p)),
      [{ id: 'games', title: 'Games' }],
    );
    const builds = renamed.pages.get('factorio-builds')!;
    expect(retarget(renamed, builds, 'Factorio/Builds')).toBe('Factorio 2/Builds');
    expect(retarget(renamed, builds, 'Builds')).toBeNull();
    expect(retarget(renamed, renamed.pages.get('factorio')!, 'Factorio')).toBe('Factorio 2');
  });
});

describe('normalizeTag', () => {
  it('normalises case, spaces and symbols', () => {
    expect(normalizeTag('#Gaming')).toBe('gaming');
    expect(normalizeTag('  Open World  RPG ')).toBe('open-world-rpg');
    expect(normalizeTag('gaming//RPG/')).toBe('gaming/rpg');
    expect(normalizeTag('Spiele & Rätsel!')).toBe('spiele-rätsel');
    expect(normalizeTag('###')).toBe('');
  });
});
