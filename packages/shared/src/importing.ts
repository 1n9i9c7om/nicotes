import { z } from 'zod';
import { normalizeTag } from './tags';

// ---------- Settings ----------

export const DEFAULT_OPENROUTER_MODEL = 'z-ai/glm-5.3-flashx';
/** Embeddings for semantic search, related pages and "Ask your notes". */
export const DEFAULT_EMBEDDING_MODEL = 'openai/text-embedding-3-small';
/** Pages with these tags keep their checklists out of the task list (imported recipes). */
export const DEFAULT_TASK_EXCLUDE_TAGS = ['recipe'];
/**
 * The AI features. Each can use its own model; unset ones use the default model
 * (`openrouter.model`), so one cheap model can run everything.
 */
export const AI_TASKS = ['import', 'organize', 'research', 'ask', 'assistant', 'summary', 'links', 'layout'] as const;
export type AiTask = (typeof AI_TASKS)[number];

export const AI_TASK_INFO: Record<AiTask, { label: string; hint: string }> = {
  import: {
    label: 'Smart Import',
    hint: 'Turns a web page into a structured note, one call per import. A fast, cheap model is enough.',
  },
  organize: {
    label: 'Organize',
    hint: 'Reviews whole notebooks for tags, moves and groups. Small models are inconsistent here; a stronger one pays off.',
  },
  research: {
    label: 'Research',
    hint: 'Plans searches, reads sources and writes a cited note: several calls per run, the most demanding task.',
  },
  ask: {
    label: 'Ask your notes',
    hint: 'Answers from your notes with citations. Needs a model that sticks to the given sources.',
  },
  assistant: {
    label: 'Page assistant',
    hint: 'Chats about the open page and proposes edits to it. Rewrites the whole page per change, so it needs a model that keeps text it was not asked to change.',
  },
  summary: { label: 'Summaries', hint: 'One to three sentences per page. Any cheap model works.' },
  links: { label: 'Link suggestions', hint: 'Finds words in a page that should link to other pages.' },
  layout: {
    label: 'Page layouts',
    hint: 'Recognises recipes, checklists, guides and stories for the interactive view. One short call per page.',
  },
};

/** Services that run the chat models. Embeddings (semantic index) always use OpenRouter. */
export const AI_PROVIDERS = ['openrouter', 'routeway'] as const;
export type AiProvider = (typeof AI_PROVIDERS)[number];
export const AI_PROVIDER_LABELS: Record<AiProvider, string> = { openrouter: 'OpenRouter', routeway: 'Routeway' };

/** Routeway models are stored as "routeway:<id>"; every other model id is an OpenRouter one. */
export const ROUTEWAY_PREFIX = 'routeway:';
export const providerOf = (model: string): AiProvider => (model.startsWith(ROUTEWAY_PREFIX) ? 'routeway' : 'openrouter');
/** The id the provider itself uses (without the "routeway:" prefix). */
export const providerModelId = (model: string) =>
  model.startsWith(ROUTEWAY_PREFIX) ? model.slice(ROUTEWAY_PREFIX.length) : model;

/** Default spending limit per AI job (research run, organize run), in USD. */
export const DEFAULT_AI_COST_LIMIT = 0.5;

/** Where an effective setting comes from: the user's settings, an environment variable, or nowhere. */
export type SettingSource = 'settings' | 'env' | 'default' | null;

export interface Settings {
  openrouter: {
    /** Secrets are never sent to the browser, only whether one is configured. */
    apiKeySet: boolean;
    apiKeySource: SettingSource;
    model: string;
    modelSource: SettingSource;
  };
  routeway: {
    apiKeySet: boolean;
    apiKeySource: SettingSource;
  };
  crawl4ai: {
    url: string | null;
    urlSource: SettingSource;
    tokenSet: boolean;
    tokenSource: SettingSource;
  };
  /** Model per AI feature; `model` null means the default model is used. */
  models: Record<AiTask, { model: string | null; source: SettingSource }>;
  ai: {
    searxngUrl: string | null;
    searxngUrlSource: SettingSource;
    costLimit: number;
    costLimitSource: SettingSource;
  };
  daily: {
    /** Notebook for daily notes; a "Journal" notebook is created on first use. */
    notebookId: string | null;
    /** Template page for new daily notes. */
    templateId: string | null;
  };
  tasks: {
    excludeTags: string[];
    excludeTagsSource: SettingSource;
  };
  semantic: {
    /** Opt-in: indexing sends all note text to OpenRouter for embeddings. */
    enabled: boolean;
    enabledSource: SettingSource;
    model: string;
    modelSource: SettingSource;
  };
}

const optionalSecret = z.string().trim().max(500).nullable().optional();
const optionalUrl = z
  .string()
  .trim()
  .max(500)
  .refine((v) => v === '' || /^https?:\/\/[^\s]+$/i.test(v), 'Must be an http(s) URL')
  .nullable()
  .optional();

const modelId = z.string().trim().max(200).nullable().optional();

/** Settings field of an AI task's model, e.g. `askModel`. */
export const modelSetting = (task: AiTask) => `${task}Model` as const;

/** `null` clears a stored value (falling back to the environment), `undefined` leaves it. */
export const settingsUpdateSchema = z.object({
  openrouterApiKey: optionalSecret,
  openrouterModel: modelId,
  routewayApiKey: optionalSecret,
  crawl4aiUrl: optionalUrl,
  crawl4aiToken: optionalSecret,
  importModel: modelId,
  organizeModel: modelId,
  researchModel: modelId,
  askModel: modelId,
  assistantModel: modelId,
  summaryModel: modelId,
  linksModel: modelId,
  layoutModel: modelId,
  searxngUrl: optionalUrl,
  aiCostLimit: z.number().min(0.01).max(50).nullable().optional(),
  dailyNotebookId: z.string().max(64).nullable().optional(),
  dailyTemplateId: z.string().max(64).nullable().optional(),
  tasksExcludeTags: z
    .array(z.string().max(60))
    .max(20)
    .transform((list) => [...new Set(list.map(normalizeTag).filter(Boolean))])
    .nullable()
    .optional(),
  semanticIndex: z.boolean().nullable().optional(),
  embeddingModel: modelId,
});
export type SettingsUpdate = z.infer<typeof settingsUpdateSchema>;

export interface ConnectionCheck {
  ok: boolean;
  message: string;
}

export interface ModelInfo {
  /** The id as stored in settings ("routeway:" prefixed for Routeway). */
  id: string;
  name: string;
  provider: AiProvider;
  /** USD per million input tokens. */
  promptPrice: number | null;
  /** USD per million output tokens (null for embedding models). */
  completionPrice: number | null;
  /** Tokens. */
  contextLength: number | null;
  /** Supports tool / function calling. */
  tools: boolean;
  /** Has a reasoning mode. */
  reasoning: boolean;
  free: boolean;
}

/** GET /api/settings/models: the models of every reachable service. */
export interface ModelList {
  models: ModelInfo[];
  /** Services whose list could not be loaded. */
  errors: string[];
}

// ---------- Import ----------

export const IMPORT_PROFILES = ['recipe', 'article', 'product', 'event', 'generic'] as const;
export type ImportProfile = (typeof IMPORT_PROFILES)[number];

export const PROFILE_LABELS: Record<ImportProfile, string> = {
  recipe: 'Recipe',
  article: 'Article',
  product: 'Product',
  event: 'Event',
  generic: 'Generic',
};

export const importRequestSchema = z
  .object({
    url: z.string().trim().url().max(2000).optional(),
    /** Pasted text/Markdown, for pages that can't be fetched. */
    text: z.string().max(200_000).optional(),
    profile: z.enum(['auto', ...IMPORT_PROFILES]).default('auto'),
    /** Article only: append the cleaned full text below the summary. */
    includeFullText: z.boolean().default(false),
  })
  .refine((r) => r.url || r.text?.trim(), 'Provide a URL or some text');
export type ImportRequest = z.input<typeof importRequestSchema>;

export interface ImportPreview {
  profile: ImportProfile;
  title: string;
  markdown: string;
  /** Tags suggested for the profile, e.g. `recipe`. */
  suggestedTags: string[];
  source: { url: string | null; siteName: string | null };
  /** How the data was obtained. */
  method: 'structured-data' | 'llm' | 'clip';
  extractor: 'crawl4ai' | 'readability' | 'text';
  warnings: string[];
  usage: { model: string; promptTokens: number; completionTokens: number; cost: number } | null;
}
