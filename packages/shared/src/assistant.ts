import { z } from 'zod';
import type { AskSource } from './insight';

// ---------- Read access for AI features ----------

/**
 * Which notes an AI feature may read besides the open page. The assistant never writes to
 * any page but the open one, and only with the user's approval.
 */
export const READ_SCOPES = ['page', 'section', 'notebook', 'all'] as const;
export type ReadScope = (typeof READ_SCOPES)[number];

export const READ_SCOPE_INFO: Record<ReadScope, { label: string; hint: string }> = {
  page: { label: 'This page only', hint: 'Reads nothing but the open page.' },
  section: {
    label: 'This section',
    hint: 'Also reads the parent page and everything under it (for a top-level page: its subpages).',
  },
  notebook: { label: 'This notebook', hint: 'Also reads the other pages of this notebook.' },
  all: { label: 'All notebooks', hint: 'Also reads pages from all your notebooks.' },
};

export const DEFAULT_ASSISTANT_SCOPE: ReadScope = 'page';

// ---------- Page assistant ----------

export const assistantRequestSchema = z.object({
  message: z.string().trim().min(1).max(4000),
  /** The page as the user currently sees it (may include unsaved edits). */
  title: z.string().max(300).default(''),
  content: z.string().max(200_000),
  /** Earlier turns, oldest first. Proposals are not repeated; the content is always current. */
  history: z
    .array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().max(8000) }))
    .max(12)
    .default([]),
  scope: z.enum(READ_SCOPES).default(DEFAULT_ASSISTANT_SCOPE),
  /** Search the web and read a few sources first. */
  research: z.boolean().default(false),
});
export type AssistantRequest = z.input<typeof assistantRequestSchema>;

export interface WebSource {
  n: number;
  url: string;
  title: string;
}

/** Server-sent events of POST /api/ai/pages/:id/assistant, one JSON object per `data:` line. */
export type AssistantEvent =
  | { type: 'step'; text: string }
  /** Notes (numbered [1], [2], …) and web sources ([W1], …) the answer may draw on. */
  | { type: 'context'; notes: AskSource[]; web: WebSource[]; /** Why the web research came back empty. */ webError?: string }
  | { type: 'delta'; text: string }
  /** The whole page as the assistant would write it; the client shows it as a diff to approve. */
  | { type: 'proposal'; content: string }
  /** `unchanged`: the assistant rewrote the page but nothing in it changed. */
  | { type: 'done'; cost: number; model: string; unchanged?: boolean }
  | { type: 'error'; message: string };

// ---------- Applying reviewed changes ----------

/** Replaces a page's content after the user reviewed a diff (AI proposal or partial restore). */
export const pageChangesSchema = z.object({
  content: z.string().max(1_000_000),
  /** The version the diff was computed against; a newer server copy is a conflict (409). */
  baseVersion: z.number().int().min(0),
  reason: z.enum(['assistant', 'restore']),
});
export type PageChanges = z.input<typeof pageChangesSchema>;
