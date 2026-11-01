import { z } from 'zod';

/** What a read-only link shows: a page (optionally with its subpages) or a whole notebook. */
export const SHARE_KINDS = ['page', 'notebook'] as const;
export type ShareKind = (typeof SHARE_KINDS)[number];

/** The web address of a shared link, relative to the server. */
export const sharePath = (token: string, pageId?: string) => `/s/${token}${pageId ? `/${pageId}` : ''}`;

export const shareCreateSchema = z.object({
  kind: z.enum(SHARE_KINDS),
  targetId: z.string().min(1).max(64),
  /** Pages only: subpages are shared too, including ones added later. */
  includeChildren: z.boolean().default(false),
  /** null: until it is turned off. */
  expiresInDays: z.number().int().min(1).max(3650).nullable().default(null),
});
export type ShareCreate = z.input<typeof shareCreateSchema>;

/** A link as its owner sees it. */
export interface Share {
  id: string;
  kind: ShareKind;
  targetId: string;
  /** The page's or notebook's current title. */
  title: string;
  includeChildren: boolean;
  /** The page or notebook is in the trash: the link shows nothing until it is restored. */
  trashed: boolean;
  /** `/s/<token>`; null when the token can no longer be decrypted (NICOTES_SECRET changed). */
  path: string | null;
  createdAt: number;
  expiresAt: number | null;
  viewCount: number;
  lastViewedAt: number | null;
}

/** GET /api/public/shares/<token>: everything a visitor sees, without signing in. */
export interface PublicShare {
  kind: ShareKind;
  /** The notebook's title, or the shared page's. */
  title: string;
  /** Notebook colour, for a notebook link. */
  color: string | null;
  /** The page a link opens with: the shared page, or the notebook's first page. */
  startId: string | null;
  /** In tree order; `parentId` is null for pages at the top of what is shared. */
  pages: PublicSharePage[];
  expiresAt: number | null;
}

export interface PublicSharePage {
  id: string;
  parentId: string | null;
  title: string;
  /** Markdown; attachment addresses point at the share's own attachment route. */
  content: string;
  updatedAt: number;
}
