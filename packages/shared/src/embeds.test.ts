import { describe, expect, it } from 'vitest';
import { sectionOf } from './sections';
import { buildLinkContext, extractWikilinks, mapWikilinks, resolveWikilink, splitSection, type LinkablePage } from './wikilinks';

describe('sections in links and embeds', () => {
  it('splits a section off a link target, but not "#" in titles', () => {
    expect(splitSection('Bread#Steps')).toEqual({ page: 'Bread', section: 'Steps' });
    expect(splitSection('Games/Bread#Two words')).toEqual({ page: 'Games/Bread', section: 'Two words' });
    expect(splitSection('C# notes')).toEqual({ page: 'C# notes', section: null });
    expect(splitSection('Issue #42')).toEqual({ page: 'Issue #42', section: null });
    expect(splitSection('C#')).toEqual({ page: 'C#', section: null });
  });

  it('links to the page, keeps the section when rewriting, and resolves titles with "#" first', () => {
    expect(extractWikilinks('![[Bread#Steps|steps]] and [[Bread#Flour]]')).toEqual([{ target: 'Bread', label: 'steps', section: 'Steps' }]);
    expect(mapWikilinks('![[Bread#Steps|steps]]', () => 'Sourdough')).toBe('![[Sourdough#Steps|steps]]');

    const page = (id: string, title: string): LinkablePage => ({ id, title, notebookId: 'n', parentId: null, createdAt: 0 });
    const ctx = buildLinkContext([page('a', 'Bread'), page('b', 'C#Tips')], [{ id: 'n', title: 'Notes' }]);
    expect(resolveWikilink(ctx, 'Bread#Steps')?.id).toBe('a');
    expect(resolveWikilink(ctx, 'C#Tips')?.id).toBe('b');
  });

  it('cuts out a section up to the next heading of its level', () => {
    const md = '# Bread\n\nIntro\n\n## Flour\n\nRye\n\n## Steps\n\n1. Mix\n\n### Tip\n\n```\n## not a heading\n```\n\n## Notes\n\nDone';
    expect(sectionOf(md, 'steps')).toBe('## Steps\n\n1. Mix\n\n### Tip\n\n```\n## not a heading\n```');
    expect(sectionOf(md, 'Notes')).toBe('## Notes\n\nDone');
    expect(sectionOf(md, 'Missing')).toBeNull();
  });
});
