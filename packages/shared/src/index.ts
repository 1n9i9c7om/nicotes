import { z } from 'zod';
import { normalizeTag } from './tags';

export * from './ai';
export * from './tags';
export * from './history';
export * from './importing';
export * from './wikilinks';

// ---------- Auth ----------

export const credentialsSchema = z.object({
  username: z.string().trim().min(1).max(64),
  password: z.string().min(8).max(256),
});
export type Credentials = z.infer<typeof credentialsSchema>;

/** Login does not enforce the password policy, only account creation does. */
export const loginSchema = credentialsSchema.extend({ password: z.string().min(1).max(256) });

export interface User {
  id: string;
  username: string;
}

export interface AuthStatus {
  user: User | null;
  /** True while no account exists yet and the setup screen should be shown. */
  setupRequired: boolean;
}

// ---------- Notebooks ----------

const colorSchema = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/)
  .nullable();

export const notebookCreateSchema = z.object({
  title: z.string().trim().min(1).max(200),
  icon: z.string().max(32).nullable().optional(),
  color: colorSchema.optional(),
});
export type NotebookCreate = z.infer<typeof notebookCreateSchema>;

export const notebookUpdateSchema = notebookCreateSchema.partial();
export type NotebookUpdate = z.infer<typeof notebookUpdateSchema>;

export const notebookMoveSchema = z.object({
  index: z.number().int().min(0),
});
export type NotebookMove = z.infer<typeof notebookMoveSchema>;

export interface Notebook {
  id: string;
  title: string;
  icon: string | null;
  color: string | null;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
}

// ---------- Pages ----------

export const pageCreateSchema = z.object({
  notebookId: z.string().min(1),
  parentId: z.string().min(1).nullable().optional(),
  title: z.string().trim().max(300).optional(),
  content: z.string().max(5_000_000).optional(),
});
export type PageCreate = z.infer<typeof pageCreateSchema>;

export const pageUpdateSchema = z.object({
  title: z.string().trim().max(300).optional(),
  content: z.string().max(5_000_000).optional(),
  /**
   * The content version the client's edit is based on; a mismatch yields 409.
   * Required when `content` is sent. Title-only changes do not touch the version.
   */
  baseVersion: z.number().int().min(1).optional(),
});
export type PageUpdate = z.infer<typeof pageUpdateSchema>;

export const pageMoveSchema = z.object({
  notebookId: z.string().min(1),
  parentId: z.string().min(1).nullable(),
  /** Position among the new siblings (0 = first). */
  index: z.number().int().min(0),
});
export type PageMove = z.infer<typeof pageMoveSchema>;

/** Lightweight page record used to build the sidebar tree. */
export interface PageSummary {
  id: string;
  notebookId: string;
  parentId: string | null;
  title: string;
  sortOrder: number;
  /** Normalised tag names, sorted. */
  tags: string[];
  createdAt: number;
  updatedAt: number;
}

export interface Page extends PageSummary {
  content: string;
  version: number;
}

/** Response of PATCH /pages/:id and PATCH /notebooks/:id. */
export interface RenameResult {
  /** Pages whose content was rewritten because links to a renamed page/notebook changed. */
  relinked: string[];
}

export interface Backlink {
  id: string;
  notebookId: string;
  title: string;
  /** The line containing the link. */
  excerpt: string;
}

// ---------- Tags ----------

const tagName = z
  .string()
  .transform(normalizeTag)
  .pipe(z.string().min(1, 'Tag name is empty'));

export const pageTagsSchema = z.object({ tags: z.array(tagName).max(50) });
export type PageTags = z.infer<typeof pageTagsSchema>;

export const tagUpdateSchema = z.object({
  name: tagName.optional(),
  description: z.string().max(20_000).optional(),
  color: colorSchema.optional(),
  inherit: z.boolean().optional(),
});
export type TagUpdate = z.infer<typeof tagUpdateSchema>;

export interface Tag {
  name: string;
  description: string;
  color: string | null;
  /** Subpages of tagged pages count as tagged too. */
  inherit: boolean;
  /** Number of live pages carrying the tag directly. */
  count: number;
}

// ---------- Search ----------

/** Marks around matched terms in search excerpts (control characters, never in user text). */
export const MATCH_START = String.fromCharCode(1);
export const MATCH_END = String.fromCharCode(2);

export interface SearchResult {
  id: string;
  notebookId: string;
  title: string;
  /** Excerpt with matches wrapped in MATCH_START / MATCH_END. */
  excerpt: string;
}

// ---------- Attachments ----------

export interface Attachment {
  id: string;
  /** Same-origin URL to embed in Markdown. */
  url: string;
  filename: string;
  mime: string;
  size: number;
}

export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

// ---------- Errors ----------

export interface ApiError {
  error: string;
  /** Present on 409 conflicts: the current server copy of the page. */
  current?: Page;
}

export const UNTITLED = 'Untitled';
