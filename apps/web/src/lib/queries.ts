import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type {
  AuthStatus,
  Backlink,
  ConnectionCheck,
  Credentials,
  ImportPreview,
  ImportRequest,
  ModelInfo,
  Notebook,
  NotebookCreate,
  NotebookUpdate,
  Page,
  PageCreate,
  PageMove,
  PageSummary,
  RenameResult,
  SearchResult,
  Settings,
  SettingsUpdate,
  Tag,
  TagUpdate,
  User,
} from '@nicotes/shared';
import { api } from './api';

export const keys = {
  auth: ['auth'] as const,
  notebooks: ['notebooks'] as const,
  pages: ['pages'] as const,
  page: (id: string) => ['page', id] as const,
  backlinks: (id: string) => ['backlinks', id] as const,
  tags: ['tags'] as const,
  settings: ['settings'] as const,
  models: ['models'] as const,
};

/**
 * After a rename or move the server may rewrite `[[links]]` in other pages. Refetch the ones
 * that are open (the editor adopts them if it has no unsaved edits) and refresh backlinks.
 */
function afterRelink(qc: QueryClient, result: RenameResult) {
  for (const id of result.relinked) qc.refetchQueries({ queryKey: keys.page(id), type: 'active' });
  qc.invalidateQueries({ queryKey: ['backlinks'] });
}

// ---------- Auth ----------

/** Forget everything cached for the previous user. The auth query stays, since the app observes it. */
function dropUserData(qc: QueryClient) {
  qc.removeQueries({ predicate: (q) => q.queryKey[0] !== keys.auth[0] });
}

export const useAuthStatus = () =>
  useQuery({ queryKey: keys.auth, queryFn: () => api.get<AuthStatus>('/auth/status'), staleTime: Infinity });

export function useSignIn(mode: 'login' | 'setup') {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: Credentials) => api.post<User>(`/auth/${mode}`, input),
    onSuccess: (user) => {
      dropUserData(qc);
      qc.setQueryData<AuthStatus>(keys.auth, { user, setupRequired: false });
    },
  });
}

export function useSignOut() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post('/auth/logout'),
    onSuccess: () => {
      dropUserData(qc);
      qc.setQueryData<AuthStatus>(keys.auth, { user: null, setupRequired: false });
    },
  });
}

// ---------- Notebooks ----------

export const useNotebooks = () =>
  useQuery({ queryKey: keys.notebooks, queryFn: () => api.get<Notebook[]>('/notebooks') });

export function useCreateNotebook() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: NotebookCreate) => api.post<Notebook>('/notebooks', input),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.notebooks }),
  });
}

export function useUpdateNotebook() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: NotebookUpdate & { id: string }) =>
      api.patch<Notebook & RenameResult>(`/notebooks/${id}`, input),
    onSuccess: (result) => {
      qc.invalidateQueries({ queryKey: keys.notebooks });
      afterRelink(qc, result);
    },
  });
}

export function useMoveNotebook() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, index }: { id: string; index: number }) =>
      api.post<Notebook>(`/notebooks/${id}/move`, { index }),
    onMutate: async ({ id, index }) => {
      await qc.cancelQueries({ queryKey: keys.notebooks });
      qc.setQueryData<Notebook[]>(keys.notebooks, (list) => {
        if (!list) return list;
        const moved = list.find((n) => n.id === id);
        if (!moved) return list;
        const rest = list.filter((n) => n.id !== id);
        rest.splice(Math.min(index, rest.length), 0, moved);
        return rest.map((n, i) => ({ ...n, sortOrder: i }));
      });
    },
    onSettled: () => qc.invalidateQueries({ queryKey: keys.notebooks }),
  });
}

export function useDeleteNotebook() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/notebooks/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.notebooks });
      qc.invalidateQueries({ queryKey: keys.pages });
    },
  });
}

// ---------- Pages ----------

export const usePages = () =>
  useQuery({ queryKey: keys.pages, queryFn: () => api.get<PageSummary[]>('/pages') });

/** `created` is a freshly created page handed over via navigation state, so it opens without a fetch. */
export const usePage = (id: string, created?: Page) =>
  useQuery({
    queryKey: keys.page(id),
    queryFn: () => api.get<Page>(`/pages/${id}`),
    initialData: created?.id === id ? created : undefined,
    // The editor owns the page while it is open, so never refetch underneath it; but always
    // load a fresh copy when a page is opened again (gcTime 0 drops it once closed).
    staleTime: Infinity,
    gcTime: 0,
    refetchOnWindowFocus: false,
  });

export function useCreatePage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: PageCreate) => api.post<Page>('/pages', input),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.pages }),
  });
}

/** Renames a page and patches the cached tree right away. */
export function useRenamePage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, title }: { id: string; title: string }) =>
      api.patch<Page & RenameResult>(`/pages/${id}`, { title }),
    onMutate: ({ id, title }) => {
      qc.setQueryData<PageSummary[]>(keys.pages, (list) => list?.map((p) => (p.id === id ? { ...p, title } : p)));
      qc.setQueryData<Page>(keys.page(id), (page) => (page ? { ...page, title } : page));
    },
    onSuccess: (result) => afterRelink(qc, result),
  });
}

export function useMovePage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...target }: PageMove & { id: string }) =>
      api.post<Page & RenameResult>(`/pages/${id}/move`, target),
    onMutate: async (move) => {
      await qc.cancelQueries({ queryKey: keys.pages });
      qc.setQueryData<PageSummary[]>(keys.pages, (list) => list && applyPageMove(list, move));
    },
    onSuccess: (result) => afterRelink(qc, result),
    onSettled: () => qc.invalidateQueries({ queryKey: keys.pages }),
  });
}

/** Mirrors the server's move logic so the tree updates before the request returns. */
function applyPageMove(list: PageSummary[], { id, notebookId, parentId, index }: PageMove & { id: string }) {
  const moved = list.find((p) => p.id === id);
  if (!moved) return list;
  const subtree = new Set([id]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const p of list) {
      if (p.parentId && subtree.has(p.parentId) && !subtree.has(p.id)) {
        subtree.add(p.id);
        grew = true;
      }
    }
  }
  const siblings = list
    .filter((p) => p.id !== id && p.notebookId === notebookId && p.parentId === parentId)
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((p) => p.id);
  siblings.splice(Math.min(index, siblings.length), 0, id);
  const order = new Map(siblings.map((sid, i) => [sid, i]));
  return list.map((p) => {
    let next = p;
    if (p.id === id) next = { ...next, parentId };
    if (subtree.has(p.id)) next = { ...next, notebookId };
    const sortOrder = order.get(p.id);
    return sortOrder === undefined ? next : { ...next, sortOrder };
  });
}

export function useDeletePage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/pages/${id}`),
    onSuccess: (_data, id) => {
      qc.removeQueries({ queryKey: keys.page(id) });
      qc.invalidateQueries({ queryKey: keys.pages });
      qc.invalidateQueries({ queryKey: keys.tags });
      qc.invalidateQueries({ queryKey: ['backlinks'] });
    },
  });
}

export const useBacklinks = (id: string) =>
  useQuery({ queryKey: keys.backlinks(id), queryFn: () => api.get<Backlink[]>(`/pages/${id}/backlinks`) });

// ---------- Tags ----------

export const useTags = () => useQuery({ queryKey: keys.tags, queryFn: () => api.get<Tag[]>('/tags') });

export function useSetPageTags() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, tags }: { id: string; tags: string[] }) => api.put<Page>(`/pages/${id}/tags`, { tags }),
    onSuccess: (page) => {
      qc.setQueryData<PageSummary[]>(keys.pages, (list) =>
        list?.map((p) => (p.id === page.id ? { ...p, tags: page.tags } : p)),
      );
      qc.invalidateQueries({ queryKey: keys.tags });
    },
  });
}

export function useUpdateTag() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ tag, update }: { tag: string; update: TagUpdate }) =>
      api.patch<Tag>(`/tags/${encodeURIComponent(tag)}`, update),
    onSuccess: (_tag, { update }) => {
      qc.invalidateQueries({ queryKey: keys.tags });
      if (update.name) qc.invalidateQueries({ queryKey: keys.pages });
    },
  });
}

export function useDeleteTag() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => api.delete(`/tags/${encodeURIComponent(name)}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.tags });
      qc.invalidateQueries({ queryKey: keys.pages });
    },
  });
}

// ---------- Search ----------

export const searchPages = (q: string) => api.get<SearchResult[]>(`/search?q=${encodeURIComponent(q)}`);

// ---------- Settings & import ----------

export const useSettings = () => useQuery({ queryKey: keys.settings, queryFn: () => api.get<Settings>('/settings') });

export function useUpdateSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: SettingsUpdate) => api.patch<Settings>('/settings', input),
    onSuccess: (settings) => qc.setQueryData(keys.settings, settings),
  });
}

export const useCheckConnection = () =>
  useMutation({
    mutationFn: (target: 'openrouter' | 'crawl4ai') => api.post<ConnectionCheck>('/settings/check', { target }),
  });

/** OpenRouter's model list for the picker; loaded on demand. */
export const useModels = (enabled: boolean) =>
  useQuery({
    queryKey: keys.models,
    queryFn: () => api.get<ModelInfo[]>('/settings/models'),
    enabled,
    staleTime: 60 * 60 * 1000,
  });

export const useImportPreview = () =>
  useMutation({ mutationFn: (input: ImportRequest) => api.post<ImportPreview>('/import/preview', input) });
