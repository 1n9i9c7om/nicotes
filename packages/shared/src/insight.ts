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

// ---------- Notes an AI feature read ----------

/** A passage of a note given to the model, cited as [n]. */
export interface NoteSource {
  /** Citation number, as in [1]. */
  n: number;
  pageId: string;
  notebookId: string;
  title: string;
  heading: string;
  excerpt: string;
}

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
