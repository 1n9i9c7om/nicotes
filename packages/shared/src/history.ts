import { z } from 'zod';

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

// ---------- Graph ----------

/** Resolved `[[links]]` between pages, plus links whose target page does not exist yet. */
export interface GraphLinks {
  links: { source: string; target: string }[];
  missing: { source: string; target: string }[];
}

// ---------- Daily notes & templates ----------

export const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');

export const dailyRequestSchema = z.object({
  date: dateSchema,
  /** Content for a newly created note (the client fills in the template). */
  content: z.string().max(200_000).default(''),
  tags: z.array(z.string()).max(20).default([]),
});
export type DailyRequest = z.input<typeof dailyRequestSchema>;

export interface DailyEntry {
  date: string;
  pageId: string;
}

/** Pages tagged with this are offered as templates. */
export const TEMPLATE_TAG = 'template';

export interface TemplateVars {
  date: string;
  time: string;
  weekday: string;
  title: string;
}

/**
 * Fills `{{date}}`, `{{time}}`, `{{datetime}}`, `{{weekday}}` and `{{title}}` in a template.
 * Unknown placeholders are left as they are.
 */
export function applyTemplate(text: string, vars: TemplateVars): string {
  const values: Record<string, string> = { ...vars, datetime: `${vars.date} ${vars.time}` };
  return text.replace(/\{\{\s*(\w+)\s*\}\}/g, (whole, key: string) => values[key.toLowerCase()] ?? whole);
}
