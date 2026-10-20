// ---------- Version history ----------

/** Why a snapshot exists: periodic while editing, before a link rewrite, or before a restore. */
export type VersionReason = 'edit' | 'relink' | 'restore';

export interface PageVersionSummary {
  id: string;
  title: string;
  reason: VersionReason;
  createdAt: number;
  /** Content length in characters. */
  size: number;
}

export interface PageVersion extends PageVersionSummary {
  content: string;
}

// ---------- Trash ----------

export interface TrashItem {
  kind: 'notebook' | 'page';
  id: string;
  title: string;
  /** Notebook the page belongs to (pages only). */
  notebookId: string | null;
  notebookTitle: string | null;
  deletedAt: number;
  /** Pages deleted together with this item (subpages, or a notebook's pages). */
  pageCount: number;
}

export const TRASH_RETENTION_DAYS = 30;
