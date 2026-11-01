import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Share, ShareCreate } from '@nicotes/shared';
import { api } from './api';

export const sharesKey = ['shares'] as const;

export const useShares = () => useQuery({ queryKey: sharesKey, queryFn: () => api.get<Share[]>('/shares'), staleTime: 60_000 });

export function useCreateShare() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: ShareCreate) => api.post<Share>('/shares', input),
    onSuccess: () => qc.invalidateQueries({ queryKey: sharesKey }),
  });
}

export function useDeleteShare() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/shares/${id}`),
    onSettled: () => qc.invalidateQueries({ queryKey: sharesKey }),
  });
}

/** The full address of a link, for copying. */
export const shareUrl = (share: Share) => (share.path ? `${window.location.origin}${share.path}` : null);

export const isExpired = (share: Share) => share.expiresAt !== null && share.expiresAt < Date.now();

/**
 * Links through which a page can be read: its own, a parent's that includes subpages, or its
 * notebook's. Expired links are left out.
 */
export function linksShowing(shares: Share[], page: { id: string; notebookId: string }, ancestorIds: string[]): Share[] {
  return shares.filter(
    (s) =>
      !isExpired(s) &&
      ((s.kind === 'page' && s.targetId === page.id) ||
        (s.kind === 'page' && s.includeChildren && ancestorIds.includes(s.targetId)) ||
        (s.kind === 'notebook' && s.targetId === page.notebookId)),
  );
}
