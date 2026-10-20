import { UNTITLED, type PageSummary } from '@nicotes/shared';

export interface PageTree {
  /** Children per parent id; root pages of a notebook are keyed by `root:<notebookId>`. */
  children: Map<string, PageSummary[]>;
  byId: Map<string, PageSummary>;
}

export const rootKey = (notebookId: string) => `root:${notebookId}`;

export function buildTree(pages: PageSummary[]): PageTree {
  const children = new Map<string, PageSummary[]>();
  const byId = new Map<string, PageSummary>();
  for (const page of pages) {
    byId.set(page.id, page);
    const key = page.parentId ?? rootKey(page.notebookId);
    const list = children.get(key) ?? [];
    list.push(page);
    children.set(key, list);
  }
  for (const list of children.values()) list.sort((a, b) => a.sortOrder - b.sortOrder);
  return { children, byId };
}

export const childrenOf = (tree: PageTree, page: PageSummary) => tree.children.get(page.id) ?? [];

/** Ancestors from the root down to (excluding) the page. */
export function ancestors(tree: PageTree, id: string): PageSummary[] {
  const result: PageSummary[] = [];
  let current = tree.byId.get(id);
  while (current?.parentId) {
    const parent = tree.byId.get(current.parentId);
    if (!parent) break;
    result.unshift(parent);
    current = parent;
  }
  return result;
}

export function isDescendant(tree: PageTree, id: string, maybeAncestorId: string): boolean {
  return ancestors(tree, id).some((p) => p.id === maybeAncestorId);
}

export const displayTitle = (title: string | undefined) => title?.trim() || UNTITLED;
