import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router';
import {
  buildLinkContext,
  linkTargetFor,
  pathOf,
  resolveWikilink,
  type LinkContext,
} from '@nicotes/shared';
import { fuzzyFilter } from './fuzzy';
import { useCreatePage, useNotebooks, usePages } from './queries';
import { displayTitle } from './tree';

export function useLinkContext(): LinkContext {
  const pages = usePages();
  const notebooks = useNotebooks();
  return useMemo(() => buildLinkContext(pages.data ?? [], notebooks.data ?? []), [pages.data, notebooks.data]);
}

export interface LinkSuggestion {
  /** Page id, or null for "create a new page". */
  id: string | null;
  title: string;
  /** Breadcrumb like "Games › Elden Ring". */
  where: string;
  /** What to write between the brackets. */
  target: string;
}

/**
 * Stable object the editors use to resolve and open links. It is not React state, so
 * ProseMirror node views and CodeMirror extensions can call it; `subscribe` notifies them
 * when pages change.
 */
export interface LinkBridge {
  resolve: (target: string) => { id: string; path: string } | null;
  suggest: (query: string) => LinkSuggestion[];
  open: (target: string) => void;
  subscribe: (listener: () => void) => () => void;
  /** Shared pages: links to pages that are not shared are plain text, never "create page". */
  readOnly?: boolean;
}

/** Opens a link target: navigates to the page, or creates it (in the matching place) first. */
export function useOpenWikilink(fromNotebookId: string) {
  const ctx = useLinkContext();
  const navigate = useNavigate();
  const createPage = useCreatePage();

  return useCallback(
    async (target: string) => {
      const page = resolveWikilink(ctx, target, fromNotebookId);
      if (page) {
        navigate(`/p/${page.id}`);
        return;
      }
      const segments = target.split('/').map((s) => s.trim());
      const title = segments.pop() ?? target;
      let notebookId = fromNotebookId;
      let parentId: string | null = null;
      if (segments.length) {
        const qualifier = segments.join('/');
        const parent = resolveWikilink(ctx, qualifier, fromNotebookId);
        const notebook = [...ctx.notebooks.values()].find(
          (n) => n.title.trim().toLowerCase() === qualifier.toLowerCase(),
        );
        if (parent) {
          notebookId = parent.notebookId;
          parentId = parent.id;
        } else if (notebook) {
          notebookId = notebook.id;
        }
      }
      const created = await createPage.mutateAsync({ notebookId, parentId, title });
      navigate(`/p/${created.id}`, { state: { created } });
    },
    [ctx, fromNotebookId, navigate, createPage],
  );
}

export function useLinkBridge(fromNotebookId: string): LinkBridge {
  const ctx = useLinkContext();
  const open = useOpenWikilink(fromNotebookId);
  const state = useRef({ ctx, open, fromNotebookId });
  state.current = { ctx, open, fromNotebookId };
  const listeners = useRef(new Set<() => void>());

  useEffect(() => {
    for (const listener of listeners.current) listener();
  }, [ctx]);

  return useMemo<LinkBridge>(
    () => ({
      resolve: (target) => {
        const { ctx: c, fromNotebookId: from } = state.current;
        const page = resolveWikilink(c, target, from);
        return page ? { id: page.id, path: pathOf(c, page).map(displayTitle).join(' › ') } : null;
      },
      suggest: (query) => {
        const { ctx: c } = state.current;
        const pages = [...c.pages.values()];
        const matches: LinkSuggestion[] = fuzzyFilter(pages, query, (p) => p.title, 8).map((page) => ({
          id: page.id,
          title: displayTitle(page.title),
          where: pathOf(c, page).slice(0, -1).map(displayTitle).join(' › '),
          target: linkTargetFor(c, page),
        }));
        const q = query.trim();
        const exact = matches.some((m) => m.title.toLowerCase() === q.toLowerCase());
        if (q && !exact) matches.push({ id: null, title: q, where: 'New page', target: q });
        return matches;
      },
      open: (target) => void state.current.open(target),
      subscribe: (listener) => {
        listeners.current.add(listener);
        return () => listeners.current.delete(listener);
      },
    }),
    [],
  );
}
