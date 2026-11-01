import { z } from 'zod';

/**
 * Importing a folder of Markdown notes (an Obsidian vault, or a Nicotes export) from a zip.
 * "notebooks": every top-level folder becomes a notebook (notes at the top go into one named
 * after the vault); "single": everything goes into one notebook, folders become pages.
 */
export const VAULT_IMPORT_MODES = ['notebooks', 'single'] as const;
export type VaultImportMode = (typeof VAULT_IMPORT_MODES)[number];

/** POST /api/import/vault/preview (multipart, field "file"): what an import would create. */
export interface VaultPreview {
  /** Pass back to POST /api/import/vault within 30 minutes. */
  id: string;
  /** The vault's folder name (or the zip's name). */
  name: string;
  notes: number;
  /** Images and other files the notes use; files no note uses are left out. */
  attachments: number;
  tags: number;
  /** Notebooks for "notebooks" mode, with their page counts. */
  notebooks: { title: string; pages: number; exists: boolean }[];
  /** Links to notes that are not in the vault. */
  unresolvedLinks: number;
  /** Files left out, and why (the first 50). */
  skipped: { path: string; reason: string }[];
  skippedCount: number;
}

export const vaultImportSchema = z.object({
  id: z.string().min(1).max(100),
  mode: z.enum(VAULT_IMPORT_MODES),
  /** "single" mode: the notebook's title (default: the vault's name). */
  title: z.string().trim().min(1).max(200).optional(),
});
export type VaultImport = z.infer<typeof vaultImportSchema>;

export interface VaultImportResult {
  notebooks: { id: string; title: string }[];
  pages: number;
  attachments: number;
  tags: number;
}
