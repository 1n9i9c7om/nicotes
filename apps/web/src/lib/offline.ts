import { useSyncExternalStore } from 'react';
import { mergeText, type Page, type PageSync, type User } from '@nicotes/shared';

/**
 * Notes on this device, for when the server cannot be reached: a copy of every page (kept
 * up to date with GET /api/pages/sync), the last answers of the lists the app shows (notebooks,
 * pages, tags …), and edits of page text made offline, sent once the server is back.
 *
 * Kept in IndexedDB, only where it is switched on (Settings → App; on by default in the
 * installed app), and wiped on sign-out.
 */

const DB_NAME = 'nicotes-offline';
const SETTING = 'nicotes.offline';
const SYNC_EVERY = 5 * 60_000;

/** A page edit made offline: the text, and the version and text it was based on. */
interface PendingEdit {
  pageId: string;
  content: string;
  baseVersion: number;
  base: string;
  at: number;
}

export interface OfflineStatus {
  enabled: boolean;
  /** The last request reached the server. */
  online: boolean;
  syncedAt: number | null;
  /** Pages with edits not yet sent. */
  pending: number;
  /** Pages whose offline edits clashed with changes made elsewhere; kept as copies. */
  copies: string[];
}

// ---------- IndexedDB ----------

let opening: Promise<IDBDatabase> | null = null;

function database(): Promise<IDBDatabase> {
  opening ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore('pages', { keyPath: 'id' });
      db.createObjectStore('meta');
      db.createObjectStore('outbox', { keyPath: 'pageId' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      opening = null;
      reject(request.error);
    };
  });
  return opening;
}

type StoreName = 'pages' | 'meta' | 'outbox';

async function run<T>(store: StoreName, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T> {
  const db = await database();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const request = fn(tx.objectStore(store));
    tx.oncomplete = () => resolve(request ? request.result : (undefined as T));
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

const read = <T>(store: StoreName, key: string) => run<T | undefined>(store, 'readonly', (s) => s.get(key) as IDBRequest<T | undefined>);
const readAll = <T>(store: StoreName) => run<T[]>(store, 'readonly', (s) => s.getAll() as IDBRequest<T[]>);
// Stores with in-line keys refuse a key argument, even an undefined one.
const write = (store: StoreName, value: unknown, key?: string) => run(store, 'readwrite', (s) => void (key === undefined ? s.put(value) : s.put(value, key)));
const remove = (store: StoreName, key: string) => run(store, 'readwrite', (s) => void s.delete(key));

// ---------- Status ----------

let status: OfflineStatus = { enabled: false, online: true, syncedAt: null, pending: 0, copies: [] };
const initial = () => update({ enabled: offlineEnabled() });
const listeners = new Set<() => void>();

function update(patch: Partial<OfflineStatus>) {
  status = { ...status, ...patch };
  for (const listener of listeners) listener();
}

export function useOfflineStatus(): OfflineStatus {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => status,
  );
}

/** Called by the API client after every request: did it reach the server? */
export function reachedServer(reached: boolean) {
  if (status.online !== reached) update({ online: reached });
  if (reached && status.pending) void flushEdits();
}

// ---------- Setting ----------

export function offlineEnabled(): boolean {
  try {
    const stored = localStorage.getItem(SETTING);
    if (stored) return stored === 'on';
  } catch {
    // Storage blocked: decide like a fresh device.
  }
  return typeof matchMedia === 'function' && matchMedia('(display-mode: standalone)').matches;
}

export async function setOfflineEnabled(on: boolean, user: User) {
  try {
    localStorage.setItem(SETTING, on ? 'on' : 'off');
  } catch {
    // Not remembered; it applies until the app is reloaded.
  }
  update({ enabled: on });
  if (on) await syncOffline(user);
  else await clearOffline();
}

/** Forgets every note on this device (sign-out, switched off). Unsent edits are lost. */
export async function clearOffline() {
  if (typeof indexedDB === 'undefined') return;
  for (const store of ['pages', 'meta', 'outbox'] as const) await run(store, 'readwrite', (s) => void s.clear()).catch(() => undefined);
  // Attachments the service worker kept (vite.config.ts).
  if (typeof caches !== 'undefined') await caches.delete('nicotes-attachments').catch(() => undefined);
  update({ syncedAt: null, pending: 0, copies: [] });
}

// ---------- Copies of answers ----------

/** GET answers kept for offline use: the lists the app needs to show its sidebar and pages. */
const KEPT = /^\/(auth\/status|notebooks|pages|tags|settings|daily(\?.*)?|tasks\?status=\w+)$/;

/** Keeps a GET answer for offline use (only the lists in KEPT). */
export function keepAnswer(path: string, data: unknown) {
  if (!status.enabled || !KEPT.test(path)) return;
  void write('meta', data, `get:${path}`).catch(() => undefined);
}

/** The answer from this device for a GET that could not reach the server, if there is one. */
export async function offlineAnswer(path: string): Promise<unknown> {
  if (!status.enabled) return undefined;
  const pageId = /^\/pages\/([\w-]+)$/.exec(path)?.[1];
  // The page as last synced; an editor opening it picks up its offline edit (pendingEdit).
  if (pageId && pageId !== 'sync') return read<Page>('pages', pageId);
  return read('meta', `get:${path}`);
}

// ---------- Sync ----------

let syncing: Promise<void> | null = null;

/** Brings this device's copy up to date and sends edits made offline. */
export function syncOffline(user: User): Promise<void> {
  if (!status.enabled) return Promise.resolve();
  syncing ??= (async () => {
    try {
      // Another account signed in on this device: start over.
      if ((await read<string>('meta', 'user')) !== user.id) {
        await clearOffline();
        await write('meta', user.id, 'user');
      }
      // Who is signed in, so the app opens offline too.
      await write('meta', { user, setupRequired: false }, 'get:/auth/status');
      await flushEdits();
      const since = (await read<number>('meta', 'syncedAt')) ?? 0;
      const res = await fetch(`/api/pages/sync?since=${since}`, { credentials: 'same-origin' });
      if (!res.ok) return;
      const data = (await res.json()) as PageSync;
      const live = new Set(data.ids);
      const db = await database();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(['pages', 'meta'], 'readwrite');
        const pages = tx.objectStore('pages');
        for (const page of data.pages) pages.put(page);
        const keys = pages.getAllKeys();
        keys.onsuccess = () => {
          for (const key of keys.result) if (!live.has(String(key))) pages.delete(key);
        };
        tx.objectStore('meta').put(data.at, 'syncedAt');
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      // The lists the app starts from (sidebar, tags, settings), as last seen.
      for (const path of ['/notebooks', '/pages', '/tags', '/settings']) {
        const list = await fetch(`/api${path}`, { credentials: 'same-origin' });
        if (list.ok) await write('meta', await list.json(), `get:${path}`);
      }
      update({ syncedAt: data.at, online: true });
    } catch {
      update({ online: navigator.onLine });
    } finally {
      syncing = null;
    }
  })();
  return syncing;
}

/** Keeps the copy fresh while the app is open: now, every few minutes, and when back online. */
export function startOfflineSync(user: User): () => void {
  void readAll<PendingEdit>('outbox')
    .then((edits) => update({ pending: edits.length }))
    .catch(() => undefined);
  void read<number>('meta', 'syncedAt')
    .then((at) => update({ syncedAt: at ?? null }))
    .catch(() => undefined);
  const sync = () => void syncOffline(user);
  sync();
  const timer = setInterval(() => document.visibilityState === 'visible' && sync(), SYNC_EVERY);
  window.addEventListener('online', sync);
  return () => {
    clearInterval(timer);
    window.removeEventListener('online', sync);
  };
}

// ---------- Edits made offline ----------

const savedListeners = new Set<(page: Page) => void>();

/** Hears about pages saved from the queue of offline edits (to update open editors). */
export function onOfflineSaved(listener: (page: Page) => void): () => void {
  savedListeners.add(listener);
  return () => savedListeners.delete(listener);
}

/**
 * Keeps an edit that could not be sent. A page edited several times offline keeps the
 * version (and text) of the first edit as its base, for merging later.
 */
export async function keepEdit(pageId: string, content: string, baseVersion: number, base: string): Promise<boolean> {
  if (!status.enabled) return false;
  const earlier = await read<PendingEdit>('outbox', pageId);
  await write('outbox', { pageId, content, baseVersion: earlier?.baseVersion ?? baseVersion, base: earlier?.base ?? base, at: Date.now() } satisfies PendingEdit);
  const edits = await readAll<PendingEdit>('outbox');
  update({ pending: edits.length, online: false });
  return true;
}

/** A page's offline edit waiting to be sent, if any. */
export const pendingEdit = (pageId: string) => read<PendingEdit>('outbox', pageId).catch(() => undefined);

/** The edit reached the server (the open editor saved the page). */
export async function forgetEdit(pageId: string) {
  if (!status.pending) return;
  await remove('outbox', pageId).catch(() => undefined);
  update({ pending: (await readAll<PendingEdit>('outbox').catch(() => [])).length });
}

/** Pages open in an editor send their own edits; the queue leaves them alone meanwhile. */
const claimed = new Map<string, number>();

export function claimPage(pageId: string): () => void {
  claimed.set(pageId, (claimed.get(pageId) ?? 0) + 1);
  return () => {
    const left = (claimed.get(pageId) ?? 1) - 1;
    if (left) claimed.set(pageId, left);
    else claimed.delete(pageId);
  };
}

const patchPage = (id: string, content: string, baseVersion: number) =>
  fetch(`/api/pages/${id}`, {
    method: 'PATCH',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content, baseVersion }),
  });

let flushing: Promise<void> | null = null;

/**
 * Sends the edits made offline. When a page changed elsewhere meanwhile, both are combined
 * line by line; if they changed the same lines, the offline text is kept as a subpage
 * "… (offline copy)" so nothing is lost.
 */
export function flushEdits(): Promise<void> {
  flushing ??= (async () => {
    try {
      for (const edit of await readAll<PendingEdit>('outbox')) {
        if (claimed.has(edit.pageId)) continue;
        let res = await patchPage(edit.pageId, edit.content, edit.baseVersion);
        if (res.status === 409) {
          const current = ((await res.json()) as { current?: Page }).current;
          if (!current) continue;
          const merged = mergeText(edit.base, edit.content, current.content);
          if (merged !== null) res = await patchPage(edit.pageId, merged, current.version);
          else {
            res = await fetch('/api/pages', {
              method: 'POST',
              credentials: 'same-origin',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ notebookId: current.notebookId, parentId: current.id, title: `${current.title || 'Untitled'} (offline copy)`, content: edit.content }),
            });
            if (res.ok) update({ copies: [...status.copies, current.title || 'Untitled'] });
            await remove('outbox', edit.pageId);
            for (const listener of savedListeners) listener(current);
            continue;
          }
        }
        if (res.status === 404) await remove('outbox', edit.pageId);
        if (!res.ok) continue;
        const saved = (await res.json()) as Page;
        await remove('outbox', edit.pageId);
        await write('pages', saved);
        for (const listener of savedListeners) listener(saved);
      }
    } catch {
      // Still offline; tried again when a request gets through.
    } finally {
      const left = await readAll<PendingEdit>('outbox').catch(() => []);
      update({ pending: left.length });
      flushing = null;
    }
  })();
  return flushing;
}

/** Shows the copy's text right away when a page is reopened offline. */
export async function keepPageCopy(page: Page) {
  if (status.enabled) await write('pages', page).catch(() => undefined);
}

export const dismissCopies = () => update({ copies: [] });

initial();
