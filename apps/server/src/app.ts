import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { HTTPException } from 'hono/http-exception';
import { secureHeaders } from 'hono/secure-headers';
import { jobRoutes, JobRunner } from './ai/jobs.js';
import { aiRoutes, organizeJob } from './ai/organize.js';
import { researchJob } from './ai/research.js';
import type { Embedder } from './ai/embeddings.js';
import { SemanticIndex, semanticRoutes } from './ai/semantic.js';
import { askRoutes } from './ai/ask.js';
import { assistantRoutes } from './ai/assistant.js';
import { insightRoutes } from './ai/insight.js';
import { layoutRoutes } from './ai/layout.js';
import { requireAuth } from './auth.js';
import { bearerToken, tokenRoutes, tokenSignIn } from './tokens.js';
import { backupRoutes } from './backup/routes.js';
import { BackupService, type BackupOptions } from './backup/service.js';
import type { Config } from './config.js';
import type { Db } from './db/index.js';
import { importRoutes } from './import/routes.js';
import { attachmentRoutes } from './routes/attachments.js';
import { authRoutes } from './routes/auth.js';
import { dailyRoutes } from './routes/daily.js';
import { exportRoutes } from './routes/export.js';
import { graphRoutes } from './routes/graph.js';
import { mentionRoutes } from './routes/mentions.js';
import { notebookRoutes } from './routes/notebooks.js';
import { pageRoutes } from './routes/pages.js';
import { searchRoutes } from './routes/search.js';
import { taskRoutes } from './routes/tasks.js';
import { tagRoutes } from './routes/tags.js';
import { trashRoutes } from './routes/trash.js';
import { SecretBox } from './secrets.js';
import { settingsRoutes, SettingsStore } from './settings.js';
import { systemRoutes } from './system.js';

export interface AppOptions {
  db: Db;
  secureCookies: boolean;
  /** Where attachments are stored (under `<dataDir>/attachments`). */
  dataDir: string;
  /** Directory with the built web app; omitted in tests. */
  webDir?: string;
  /** Key material for stored secrets (NICOTES_SECRET); a key file in dataDir otherwise. */
  secret?: string;
  /** Environment defaults for user settings. */
  settingsEnv?: Config['env'];
  /** Allow imports from private network hosts. */
  importAllowPrivate?: boolean;
  /** Let browser extension pages show the app in a frame (the Nicotes sidebar extension). */
  browserExtension?: boolean;
  /** Backup directory and schedule; defaults to `<dataDir>/backups` with no schedule. */
  backups?: Partial<BackupOptions>;
  /** Tests: a fake embedder, and no waiting for typing to pause before indexing. */
  embedder?: Embedder;
  semanticQuietMs?: number;
}

export function createApp({
  db,
  secureCookies,
  dataDir,
  webDir,
  secret,
  settingsEnv = {} as Config['env'],
  importAllowPrivate = false,
  browserExtension = false,
  backups: backupOptions,
  embedder,
  semanticQuietMs,
}: AppOptions) {
  const app = new Hono();
  const settings = new SettingsStore(db, SecretBox.load(dataDir, secret), settingsEnv);
  const jobs = new JobRunner(db, settings);
  jobs.register('organize', organizeJob(db));
  jobs.register('research', researchJob(db, importAllowPrivate));
  const semantic = new SemanticIndex(db, settings, embedder, semanticQuietMs);
  const backups = new BackupService(
    db,
    dataDir,
    { dir: join(dataDir, 'backups'), intervalHours: 0, keepDaily: 7, keepWeekly: 4, ...backupOptions },
    Boolean(secret),
  );
  settings.onUpdate((userId, input) => {
    const affectsIndex = [input.semanticIndex, input.embeddingModel, input.openrouterApiKey, input.localAiUrl, input.localAiKey];
    if (affectsIndex.every((value) => value === undefined)) return;
    // Switched off, the index is deleted; switched on, or with another model, key or server, it (re)builds.
    if (!settings.effective(userId).semanticIndex) semantic.clear(userId);
    else {
      semantic.retry(userId);
      semantic.poke();
    }
  });

  app.onError((err, c) => {
    if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
    console.error(err);
    return c.json({ error: 'Internal server error' }, 500);
  });

  const headers = secureHeaders({
    contentSecurityPolicy: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      // CodeMirror and TipTap inject inline styles.
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
      fontSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      // Extension pages get a random origin per install (moz-extension://<uuid>), so the
      // sidebar extension can only be allowed by scheme.
      frameAncestors: browserExtension ? ['moz-extension:', 'chrome-extension:'] : ["'none'"],
    },
    // Superseded by frame-ancestors, but browsers that still honour it would block the sidebar.
    xFrameOptions: browserExtension ? false : 'SAMEORIGIN',
  });
  // Attachment downloads set their own, stricter sandbox policy.
  app.use('*', (c, next) => (c.req.path.startsWith('/api/attachments/') ? next() : headers(c, next)));

  // CSRF defence: state-changing API calls must be JSON (or bodiless). Cross-site forms
  // cannot send application/json without a CORS preflight, which this server never allows.
  // Uploads are multipart, so they must carry a custom header instead (also preflighted).
  // Requests with an API token are exempt: browsers never add one to a request by themselves.
  app.use('/api/*', async (c, next) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method) && !bearerToken(c)) {
      const type = c.req.header('content-type')?.toLowerCase();
      const json = !type || type.startsWith('application/json');
      const upload = type?.startsWith('multipart/form-data') && c.req.header('x-requested-with') === 'nicotes';
      if (!json && !upload) throw new HTTPException(415, { message: 'Expected application/json' });
    }
    await next();
  });
  const jsonLimit = bodyLimit({ maxSize: 10 * 1024 * 1024 });
  app.use('/api/*', (c, next) => (c.req.path.startsWith('/api/attachments') ? next() : jsonLimit(c, next)));

  // Signed in by session, or by API token where scripts may reach (not settings with their
  // keys, backups with the key file, or the tokens themselves).
  const auth = requireAuth(db, secureCookies, tokenSignIn(db));
  const sessionOnly = requireAuth(db, secureCookies);
  app.get('/api/health', (c) => c.json({ ok: true }));
  app.route('/api/auth', authRoutes(db, secureCookies));
  for (const area of ['notebooks', 'pages', 'tags', 'search', 'attachments', 'import', 'trash', 'export', 'jobs', 'ai', 'graph', 'daily', 'tasks', 'semantic', 'system']) {
    app.use(`/api/${area}`, auth);
    app.use(`/api/${area}/*`, auth);
  }
  for (const area of ['settings', 'backups', 'tokens']) {
    app.use(`/api/${area}`, sessionOnly);
    app.use(`/api/${area}/*`, sessionOnly);
  }
  app.route('/api/notebooks', notebookRoutes(db));
  app.route('/api/pages', pageRoutes(db));
  app.route('/api/pages', mentionRoutes(db));
  app.route('/api/tags', tagRoutes(db));
  app.route('/api/search', searchRoutes(db));
  app.route('/api/attachments', attachmentRoutes(db, dataDir));
  app.route('/api/settings', settingsRoutes(settings));
  app.route('/api/trash', trashRoutes(db));
  app.route('/api/export', exportRoutes(db, dataDir));
  app.route('/api/jobs', jobRoutes(jobs));
  app.route('/api/graph', graphRoutes(db));
  app.route('/api/daily', dailyRoutes(db, settings));
  app.route('/api/tasks', taskRoutes(db, settings));
  app.route('/api/system', systemRoutes(db, dataDir));
  app.route('/api/semantic', semanticRoutes(db, semantic));
  app.route('/api/backups', backupRoutes(backups));
  app.route('/api/tokens', tokenRoutes(db));
  app.route('/api/ai', aiRoutes(db, jobs));
  app.route('/api/ai', askRoutes(db, settings, semantic));
  app.route('/api/ai', assistantRoutes(db, settings, semantic, importAllowPrivate));
  app.route('/api/ai', insightRoutes(db, settings, semantic));
  app.route('/api/ai', layoutRoutes(db, settings));
  app.route('/api/import', importRoutes({ db, dataDir, settings, allowPrivate: importAllowPrivate }));
  app.all('/api/*', (c) => c.json({ error: 'Not found' }, 404));

  if (webDir && existsSync(join(webDir, 'index.html'))) {
    const indexHtml = readFileSync(join(webDir, 'index.html'), 'utf8');
    app.use(
      '/assets/*',
      serveStatic({
        root: webDir,
        onFound: (_path, c) => c.header('Cache-Control', 'public, max-age=31536000, immutable'),
      }),
    );
    // Everything outside /assets (index.html, sw.js, manifest) must revalidate, so app updates
    // and new service workers are picked up.
    app.use(
      '*',
      serveStatic({
        root: webDir,
        onFound: (path, c) => {
          c.header('Cache-Control', 'no-cache');
          if (path.endsWith('.webmanifest')) c.header('Content-Type', 'application/manifest+json');
        },
      }),
    );
    // SPA fallback: client-side routes all render index.html.
    app.get('*', (c) => {
      c.header('Cache-Control', 'no-cache');
      return c.html(indexHtml);
    });
  }

  return Object.assign(app, { jobs, semantic, backups });
}
