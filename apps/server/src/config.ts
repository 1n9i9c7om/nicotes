import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Both src/index.ts (dev) and dist/index.js (prod) sit one level below the package root.
const packageRoot = fileURLToPath(new URL('..', import.meta.url));

const dataDir = resolve(process.env.DATA_DIR ?? resolve(packageRoot, '../../data'));

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
  /** Defaults for settings users can override in the UI. */
  env: {
    openrouterApiKey: process.env.OPENROUTER_API_KEY?.trim() || undefined,
    openrouterModel: process.env.OPENROUTER_MODEL?.trim() || undefined,
    crawl4aiUrl: process.env.CRAWL4AI_URL?.trim() || undefined,
    crawl4aiToken: process.env.CRAWL4AI_TOKEN?.trim() || undefined,
    researchModel: process.env.OPENROUTER_RESEARCH_MODEL?.trim() || undefined,
    searxngUrl: process.env.SEARXNG_URL?.trim() || undefined,
    aiCostLimit: process.env.NICOTES_AI_COST_LIMIT?.trim() || undefined,
  },
};

export type Config = typeof config;
