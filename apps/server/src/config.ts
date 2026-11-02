import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Both src/index.ts (dev) and dist/index.js (prod) sit one level below the package root.
const packageRoot = fileURLToPath(new URL('..', import.meta.url));

const dataDir = resolve(process.env.DATA_DIR ?? resolve(packageRoot, '../../data'));

/** A non-negative whole number from the environment, or the default when unset or invalid. */
function count(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (Number.isFinite(value) && value >= 0) return value;
  console.warn(`Ignoring ${name}=${raw}: expected a number >= 0`);
  return fallback;
}

export const config = {
  port: Number(process.env.NICOTES_PORT ?? 3000),
  dataDir,
  dbFile: resolve(dataDir, 'nicotes.db'),
  migrationsFolder: resolve(packageRoot, 'drizzle'),
  webDir: resolve(process.env.WEB_DIR ?? resolve(packageRoot, '../web/dist')),
  secureCookies: process.env.NICOTES_SECURE_COOKIES === 'true',
  adminUser: process.env.NICOTES_ADMIN_USER?.trim() || undefined,
  adminPassword: process.env.NICOTES_ADMIN_PASSWORD || undefined,
  /** Key material for encrypting stored secrets; generated into DATA_DIR when unset. */
  secret: process.env.NICOTES_SECRET || undefined,
  /** Lets imports fetch hosts on private networks (off by default: SSRF protection). */
  importAllowPrivate: process.env.NICOTES_IMPORT_ALLOW_PRIVATE === 'true',
  /** Lets the browser extension show Nicotes in the browser's sidebar (off by default). */
  browserExtension: process.env.NICOTES_BROWSER_EXTENSION === 'true',
  backup: {
    dir: resolve(process.env.NICOTES_BACKUP_DIR?.trim() || resolve(dataDir, 'backups')),
    /** 0 turns automatic backups off ("Back up now" still works). */
    intervalHours: count('NICOTES_BACKUP_INTERVAL_HOURS', 24),
    keepDaily: Math.floor(count('NICOTES_BACKUP_KEEP_DAILY', 7)),
    keepWeekly: Math.floor(count('NICOTES_BACKUP_KEEP_WEEKLY', 4)),
  },
  /** Defaults for settings users can override in the UI. */
  env: {
    openrouterApiKey: process.env.OPENROUTER_API_KEY?.trim() || undefined,
    openrouterModel: process.env.OPENROUTER_MODEL?.trim() || undefined,
    routewayApiKey: process.env.ROUTEWAY_API_KEY?.trim() || undefined,
    localAiUrl: process.env.LOCAL_AI_URL?.trim() || undefined,
    localAiKey: process.env.LOCAL_AI_KEY?.trim() || undefined,
    crawl4aiUrl: process.env.CRAWL4AI_URL?.trim() || undefined,
    crawl4aiToken: process.env.CRAWL4AI_TOKEN?.trim() || undefined,
    // Per-feature models; unset ones use OPENROUTER_MODEL.
    importModel: process.env.OPENROUTER_IMPORT_MODEL?.trim() || undefined,
    organizeModel: process.env.OPENROUTER_ORGANIZE_MODEL?.trim() || undefined,
    researchModel: process.env.OPENROUTER_RESEARCH_MODEL?.trim() || undefined,
    askModel: process.env.OPENROUTER_ASK_MODEL?.trim() || undefined,
    assistantModel: process.env.OPENROUTER_ASSISTANT_MODEL?.trim() || undefined,
    summaryModel: process.env.OPENROUTER_SUMMARY_MODEL?.trim() || undefined,
    linksModel: process.env.OPENROUTER_LINKS_MODEL?.trim() || undefined,
    layoutModel: process.env.OPENROUTER_LAYOUT_MODEL?.trim() || undefined,
    imagesModel: process.env.OPENROUTER_IMAGES_MODEL?.trim() || undefined,
    searxngUrl: process.env.SEARXNG_URL?.trim() || undefined,
    aiCostLimit: process.env.NICOTES_AI_COST_LIMIT?.trim() || undefined,
    embeddingModel: process.env.OPENROUTER_EMBEDDING_MODEL?.trim() || undefined,
    semanticIndex: process.env.NICOTES_SEMANTIC_INDEX?.trim() || undefined,
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN?.trim() || undefined,
    readImages: process.env.NICOTES_READ_IMAGES?.trim() || undefined,
    transcribeUrl: process.env.TRANSCRIBE_URL?.trim() || undefined,
    transcribeKey: process.env.TRANSCRIBE_KEY?.trim() || undefined,
    transcribeModel: process.env.TRANSCRIBE_MODEL?.trim() || undefined,
  },
};

export type Config = typeof config;
