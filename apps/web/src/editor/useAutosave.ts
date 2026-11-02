import { useCallback, useEffect, useRef, useState } from 'react';
import { hashKey, useQueryClient } from '@tanstack/react-query';
import { mergeText, type Page, type PageSummary } from '@nicotes/shared';
import { api, ApiError, OfflineError } from '../lib/api';
import { claimPage, forgetEdit, keepEdit, keepPageCopy, pendingEdit } from '../lib/offline';
import { keys } from '../lib/queries';

/** "local": kept on this device while offline, sent once the server is back. */
export type SaveStatus = 'saved' | 'dirty' | 'saving' | 'error' | 'conflict' | 'local';

const DEBOUNCE_MS = 800;
const RETRY_MS = 5000;
const HAS_TASK = /\[[ xX]\]/;

/**
 * Debounced autosave for a page's Markdown content with optimistic concurrency.
 * Mount once per page (key the owner by page id); later changes to `page` are ignored.
 *
 * When the page changed elsewhere, both versions are combined line by line where they do not
 * touch the same lines; otherwise the conflict banner asks. Offline, edits are kept on the
 * device (with offline notes on) and sent when the server is back, also after a reload.
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
  /** The text last kept on this device while offline. */
  const local = useRef<string | null>(null);

  const showText = useCallback((markdown: string) => {
    latest.current = markdown;
    setContentState(markdown);
    setRevision((r) => r + 1);
  }, []);

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
      if (local.current !== null) {
        local.current = null;
        void forgetEdit(page.id);
      }
      void keepPageCopy(result);
      // The task list re-reads pages with checkboxes the next time it is shown.
      if (HAS_TASK.test(body) || HAS_TASK.test(saved.current)) {
        qc.invalidateQueries({ queryKey: keys.tasks, refetchType: 'none' });
      }
      saved.current = body;
      qc.setQueryData(keys.page(page.id), result);
      qc.setQueryData<PageSummary[]>(keys.pages, (list) =>
        list?.map((p) => (p.id === result.id ? { ...p, updatedAt: result.updatedAt } : p)),
      );
    } catch (error) {
      const current = error instanceof ApiError && error.status === 409 ? error.body?.current : undefined;
      const merged = current ? mergeText(saved.current, body, current.content) : null;
      if (current && merged !== null) {
        // Changed elsewhere, but not the same lines: carry on from both.
        version.current = current.version;
        saved.current = current.content;
        if (latest.current === body) showText(merged);
        timer.current = setTimeout(save, 0);
      } else if (current) {
        blocked.current = true;
        setConflict(current);
        setStatus('conflict');
      } else if (error instanceof OfflineError && (await keepEdit(page.id, body, version.current, saved.current).catch(() => false))) {
        local.current = body;
        setStatus(latest.current === body ? 'local' : 'dirty');
        timer.current = setTimeout(save, RETRY_MS);
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
  }, [page.id, qc, showText]);

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

  /** Replaces the text programmatically (e.g. linking a mention): editors remount with it. */
  const replaceContent = useCallback(
    (markdown: string) => {
      setContent(markdown);
      setRevision((r) => r + 1);
    },
    [setContent],
  );

  /** Resolve a conflict by keeping the local text (overwrite) or loading the server copy. */
  const resolveConflict = useCallback(
    (choice: 'mine' | 'theirs') => {
      if (!conflict) return;
      version.current = conflict.version;
      blocked.current = false;
      setConflict(null);
      if (choice === 'theirs') {
        saved.current = conflict.content;
        showText(conflict.content);
        setStatus('saved');
        if (local.current !== null) {
          local.current = null;
          void forgetEdit(page.id);
        }
      } else {
        void save();
      }
    },
    [conflict, save, showText, page.id],
  );

  // An edit kept offline earlier (perhaps before a reload) continues here, and is sent.
  useEffect(() => {
    const release = claimPage(page.id);
    void pendingEdit(page.id).then((pending) => {
      if (!pending || pending.content === latest.current) return;
      local.current = pending.content;
      if (pending.baseVersion === version.current) {
        saved.current = pending.base;
        showText(pending.content);
        setStatus('dirty');
        timer.current = setTimeout(save, 0);
        return;
      }
      // The page changed elsewhere since: combine, or let the banner ask.
      const merged = mergeText(pending.base, pending.content, latest.current);
      if (merged !== null) {
        showText(merged);
        setStatus('dirty');
        timer.current = setTimeout(save, 0);
      } else {
        blocked.current = true;
        setConflict({ ...page, content: saved.current, version: version.current });
        showText(pending.content);
        setStatus('conflict');
      }
    });
    const online = () => {
      if (local.current !== null) void save();
    };
    window.addEventListener('online', online);
    return () => {
      release();
      window.removeEventListener('online', online);
    };
  }, [page.id]);

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
      if (latest.current !== saved.current && latest.current !== local.current) {
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

  return { content, setContent, replaceContent, status, conflict, resolveConflict, revision, flush: save };
}
