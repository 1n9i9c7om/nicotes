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
};
