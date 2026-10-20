import type { PageSummary, Tag } from '@nicotes/shared';

export interface InheritedTag {
  name: string;
  /** Id of the ancestor carrying the tag. */
  fromId: string;
}

/**
 * Tags pages get from ancestors via inheriting tags (excluding tags they carry themselves),
 * the nearest ancestor winning. Mirrors the server's `inheritedTags`.
 */
export function inheritedTagMap(pages: PageSummary[], tags: Tag[]): Map<string, InheritedTag[]> {
  const inheriting = new Set(tags.filter((t) => t.inherit).map((t) => t.name));
  const result = new Map<string, InheritedTag[]>();
  if (!inheriting.size) return result;
  const byId = new Map(pages.map((p) => [p.id, p]));
  for (const page of pages) {
    const found = new Map<string, string>();
    for (let cur = page.parentId ? byId.get(page.parentId) : undefined; cur; cur = cur.parentId ? byId.get(cur.parentId) : undefined) {
      for (const tag of cur.tags) if (inheriting.has(tag) && !found.has(tag)) found.set(tag, cur.id);
    }
    for (const tag of page.tags) found.delete(tag);
    if (found.size) result.set(page.id, [...found].map(([name, fromId]) => ({ name, fromId })).sort((a, b) => a.name.localeCompare(b.name)));
  }
  return result;
}

/** Own plus inherited tag names. */
export function effectiveTags(page: PageSummary, inherited: Map<string, InheritedTag[]>): string[] {
  return [...page.tags, ...(inherited.get(page.id) ?? []).map((t) => t.name)];
}
