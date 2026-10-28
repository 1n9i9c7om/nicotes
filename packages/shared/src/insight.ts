import { z } from 'zod';

// ---------- Semantic index ----------

export interface SemanticStatus {
  enabled: boolean;
  /** An OpenRouter API key is configured. */
  ready: boolean;
  model: string;
  /** Live pages, and how many of them are indexed in their current state. */
  pages: number;
  indexed: number;
  chunks: number;
  /** USD spent on embeddings so far. */
  cost: number;
  error: string | null;
}

/** A page found by meaning, with its best matching passage. */
export interface SemanticHit {
  id: string;
  notebookId: string;
  title: string;
  heading: string;
  excerpt: string;
  score: number;
}

export interface SemanticResults<T> {
  /** False when the semantic index is switched off (results are then empty). */
  enabled: boolean;
  results: T[];
}

// ---------- Ask your notes ----------

export const askRequestSchema = z.object({
  question: z.string().trim().min(2).max(2000),
  /** Earlier turns of the conversation, oldest first. */
  history: z
    .array(z.object({ question: z.string().max(2000), answer: z.string().max(20_000) }))
    .max(6)
    .default([]),
  /** Only search these notebooks; all when left out. */
  notebookIds: z.array(z.string().max(64)).max(200).optional(),
});
export type AskRequest = z.input<typeof askRequestSchema>;

export interface AskSource {
  /** Citation number, as in [1]. */
  n: number;
  pageId: string;
  notebookId: string;
  title: string;
  heading: string;
  excerpt: string;
}

/** Server-sent events of POST /api/ai/ask, one JSON object per `data:` line. */
export type AskEvent =
  | { type: 'sources'; sources: AskSource[]; retrieval: 'semantic' | 'keyword' }
  | { type: 'delta'; text: string }
  | { type: 'done'; cost: number; model: string }
  | { type: 'error'; message: string };

// ---------- Summaries ----------

export interface PageSummaryInfo {
  summary: string;
  /** The page changed since the summary was written. */
  stale: boolean;
  model: string;
  cost: number;
  createdAt: number;
}

// ---------- AI link suggestions ----------

export interface AiLinkSuggestion {
  /** Exact text in the page that should become a link. */
  phrase: string;
  pageId: string;
  title: string;
  /** What to write between the brackets. */
  target: string;
  reason: string;
}

export interface AiLinkSuggestions {
  suggestions: AiLinkSuggestion[];
  cost: number;
}
