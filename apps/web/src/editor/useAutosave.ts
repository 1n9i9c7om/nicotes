import { useCallback, useEffect, useRef, useState } from 'react';
import { hashKey, useQueryClient } from '@tanstack/react-query';
import type { Page, PageSummary } from '@nicotes/shared';
import { api, ApiError } from '../lib/api';
import { keys } from '../lib/queries';

export type SaveStatus = 'saved' | 'dirty' | 'saving' | 'error' | 'conflict';

const DEBOUNCE_MS = 800;
const RETRY_MS = 5000;

/**
 * Debounced autosave for a page's Markdown content with optimistic concurrency.
 * Mount once per page (key the owner by page id); later changes to `page` are ignored.
 */
export function useAutosave(page: Page) {
  const qc = useQueryClient();
  const [content, setContentState] = useState(page.content);
  const [status, setStatus] = useState<SaveStatus>('saved');
  const [conflict, setConflict] = useState<Page | null>(null);
  /** Bumped when content is replaced from outside, so editors remount with it. */
  const [revision, setRevision] = useState(0);

  const version = useRef(page.version);
  const latest = useRef(page.content);
  const saved = useRef(page.content);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const inFlight = useRef(false);
  const blocked = useRef(false); // true while a conflict is unresolved

  const save = useCallback(async (): Promise<void> => {
    clearTimeout(timer.current);
    if (inFlight.current || blocked.current) return;
    const body = latest.current;
    if (body === saved.current) {
      setStatus('saved');
      return;
    }
    inFlight.current = true;
    setStatus('saving');
    try {
      const result = await api.patch<Page>(`/pages/${page.id}`, { content: body, baseVersion: version.current });
      version.current = result.version;
      saved.current = body;
      qc.setQueryData(keys.page(page.id), result);
      qc.setQueryData<PageSummary[]>(keys.pages, (list) =>
        list?.map((p) => (p.id === result.id ? { ...p, updatedAt: result.updatedAt } : p)),
      );
    } catch (error) {
      if (error instanceof ApiError && error.status === 409 && error.body?.current) {
        blocked.current = true;
        setConflict(error.body.current);
        setStatus('conflict');
      } else {
        setStatus('error');
        timer.current = setTimeout(save, RETRY_MS);
      }
      return;
    } finally {
      inFlight.current = false;
    }
    // Edits made while the request was in flight still need saving.
    if (latest.current !== saved.current) timer.current = setTimeout(save, DEBOUNCE_MS);
    else setStatus('saved');
  }, [page.id, qc]);

  const setContent = useCallback(
    (markdown: string) => {
      latest.current = markdown;
      setContentState(markdown);
      if (blocked.current) return;
      setStatus((s) => (s === 'saving' ? s : 'dirty'));
      clearTimeout(timer.current);
      timer.current = setTimeout(save, DEBOUNCE_MS);
    },
    [save],
  );

  /** Resolve a conflict by keeping the local text (overwrite) or loading the server copy. */
  const resolveConflict = useCallback(
    (choice: 'mine' | 'theirs') => {
      if (!conflict) return;
      version.current = conflict.version;
      blocked.current = false;
      setConflict(null);
      if (choice === 'theirs') {
        latest.current = saved.current = conflict.content;
        setContentState(conflict.content);
        setRevision((r) => r + 1);
        setStatus('saved');
      } else {
        void save();
      }
    },
    [conflict, save],
  );

  // A newer server copy (e.g. links rewritten after a rename) replaces the text silently when
  // nothing is unsaved; with local edits the next save runs into the conflict banner instead.
  useEffect(
    () =>
      qc.getQueryCache().subscribe((event) => {
        if (event.type !== 'updated' || event.query.queryHash !== hashKey(keys.page(page.id))) return;
        const remote = event.query.state.data as Page | undefined;
        if (!remote || remote.version <= version.current) return;
        if (inFlight.current || blocked.current || latest.current !== saved.current) return;
        version.current = remote.version;
        latest.current = saved.current = remote.content;
        setContentState(remote.content);
        setRevision((r) => r + 1);
      }),
    [page.id, qc],
  );

  // Flush on page switch/unmount, and warn before closing the tab with unsaved changes.
  useEffect(() => {
    const beforeUnload = (e: BeforeUnloadEvent) => {
      if (latest.current !== saved.current) {
        void save();
        e.preventDefault();
      }
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => {
      window.removeEventListener('beforeunload', beforeUnload);
      void save();
    };
  }, [save]);

  return { content, setContent, status, conflict, resolveConflict, revision, flush: save };
}
