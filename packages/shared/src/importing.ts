import { z } from 'zod';

// ---------- Settings ----------

export const DEFAULT_OPENROUTER_MODEL = 'z-ai/glm-5.3-flashx';

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
  crawl4ai: {
    url: string | null;
    urlSource: SettingSource;
    tokenSet: boolean;
    tokenSource: SettingSource;
  };
}

const optionalSecret = z.string().trim().max(500).nullable().optional();

/** `null` clears a stored value (falling back to the environment), `undefined` leaves it. */
export const settingsUpdateSchema = z.object({
  openrouterApiKey: optionalSecret,
  openrouterModel: z.string().trim().max(200).nullable().optional(),
  crawl4aiUrl: z
    .string()
    .trim()
    .max(500)
    .refine((v) => /^https?:\/\/[^\s]+$/i.test(v), 'Must be an http(s) URL')
    .nullable()
    .optional(),
  crawl4aiToken: optionalSecret,
});
export type SettingsUpdate = z.infer<typeof settingsUpdateSchema>;

export interface ConnectionCheck {
  ok: boolean;
  message: string;
}

export interface ModelInfo {
  id: string;
  name: string;
  /** USD per million input tokens. */
  promptPrice: number | null;
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
  usage: { model: string; promptTokens: number; completionTokens: number } | null;
}
