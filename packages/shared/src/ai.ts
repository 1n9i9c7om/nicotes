import { z } from 'zod';
import { AI_PROVIDER_LABELS, type AiProvider } from './importing';

// ---------- Jobs ----------

export type JobKind = 'research' | 'organize';
export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

export interface JobProgress {
  /** Current step, e.g. "Reading 3 of 8 sources". */
  message?: string;
  done?: number;
  total?: number;
  /** Recent step log, newest last. */
  log?: string[];
}

export interface Job<I = unknown, R = unknown> {
  id: string;
  kind: JobKind;
  status: JobStatus;
  input: I;
  progress: JobProgress;
  result: R | null;
  error: string | null;
  /** USD spent on OpenRouter so far. */
  cost: number;
  createdAt: number;
  updatedAt: number;
}

export const isActiveJob = (job: Pick<Job, 'status'>) => job.status === 'queued' || job.status === 'running';

// ---------- Organize (LLM tagging & grouping) ----------

export const organizeRequestSchema = z.object({
  scope: z.object({ kind: z.enum(['page', 'subtree', 'notebook']), id: z.string().min(1) }),
  tags: z.boolean().default(true),
  moves: z.boolean().default(true),
  groups: z.boolean().default(true),
});
export type OrganizeRequest = z.input<typeof organizeRequestSchema>;

interface SuggestionBase {
  id: string;
  reason: string;
}

export type OrganizeSuggestion =
  | (SuggestionBase & {
      type: 'tag';
      pageId: string;
      pageTitle: string;
      tags: string[];
      /** Tags that do not exist yet. */
      newTags: string[];
    })
  | (SuggestionBase & {
      type: 'move';
      pageId: string;
      pageTitle: string;
      parentId: string | null;
      parentTitle: string | null;
    })
  | (SuggestionBase & {
      type: 'group';
      title: string;
      notebookId: string;
      parentId: string | null;
      parentTitle: string | null;
      pageIds: string[];
      pageTitles: string[];
    });

export interface OrganizeResult {
  scopeTitle: string;
  pageCount: number;
  suggestions: OrganizeSuggestion[];
  /** Set once suggestions were applied. */
  batchId?: string;
}

export const organizeApplySchema = z.object({ ids: z.array(z.string()).min(1) });

export interface AiBatch {
  id: string;
  jobId: string | null;
  summary: string;
  createdAt: number;
  undoneAt: number | null;
}

// ---------- Research ----------

export const RESEARCH_DEPTHS = {
  quick: { label: 'Quick', queries: 2, sources: 4 },
  standard: { label: 'Standard', queries: 4, sources: 8 },
  deep: { label: 'Deep', queries: 6, sources: 14 },
} as const;
export type ResearchDepth = keyof typeof RESEARCH_DEPTHS;

export const researchRequestSchema = z.object({
  question: z.string().trim().min(3).max(2000),
  depth: z.enum(['quick', 'standard', 'deep']).default('standard'),
  notebookId: z.string().min(1),
  parentId: z.string().min(1).nullable().default(null),
});
export type ResearchRequest = z.input<typeof researchRequestSchema>;

export interface ResearchResult {
  pageId: string;
  title: string;
  sources: number;
  searchProvider: 'searxng' | AiProvider;
}

/** "SearXNG" or e.g. "OpenRouter web search". */
export const searchLabel = (provider: ResearchResult['searchProvider']) =>
  provider === 'searxng' ? 'SearXNG' : `${AI_PROVIDER_LABELS[provider]} web search`;
