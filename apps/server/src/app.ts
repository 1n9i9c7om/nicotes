import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { serveStatic } from '@hono/node-server/serve-static';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { HTTPException } from 'hono/http-exception';
import { secureHeaders } from 'hono/secure-headers';
import { adapterRoutes } from './adapters/routes.js';
import { AdapterService, type AdapterOptions } from './adapters/service.js';
import { jobRoutes, JobRunner } from './ai/jobs.js';
import { aiRoutes, organizeJob } from './ai/organize.js';
import { researchJob } from './ai/research.js';
import type { Embedder } from './ai/embeddings.js';
import { SemanticIndex, semanticRoutes } from './ai/semantic.js';
import { askRoutes } from './ai/ask.js';
import { assistantRoutes } from './ai/assistant.js';
import { insightRoutes } from './ai/insight.js';
import { layoutRoutes } from './ai/layout.js';
import { AttachmentReader, type ImageReader } from './attachmentText.js';
import { requireAuth } from './auth.js';
import { resetChat, runChat } from './chat/agent.js';
import { chatRoutes } from './chat/routes.js';
import { transcribe } from './ai/transcribe.js';
import { users } from './db/schema.js';
import { bearerToken, tokenRoutes, tokenSignIn } from './tokens.js';
import { backupRoutes } from './backup/routes.js';
import { BackupService, type BackupOptions } from './backup/service.js';
import type { Config } from './config.js';
import type { Db } from './db/index.js';
import { importRoutes } from './import/routes.js';
import { vaultRoutes } from './import/vault.js';
import { attachmentRoutes } from './routes/attachments.js';
import { authRoutes } from './routes/auth.js';
import { calendarRoutes } from './routes/calendar.js';
import { dailyRoutes } from './routes/daily.js';
import { exportRoutes } from './routes/export.js';
import { graphRoutes } from './routes/graph.js';
import { mentionRoutes } from './routes/mentions.js';
import { notebookRoutes } from './routes/notebooks.js';
import { pageRoutes } from './routes/pages.js';
import { searchRoutes } from './routes/search.js';
import { reminderRoutes } from './routes/reminders.js';
import { securityRoutes } from './routes/security.js';
import { publicShareRoutes, shareRoutes } from './routes/shares.js';
import { taskRoutes } from './routes/tasks.js';
import { tagRoutes } from './routes/tags.js';
import { trashRoutes } from './routes/trash.js';
import { ReminderService, type ReminderOptions } from './reminders.js';
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
  /** Tests: fake push services, Telegram and clock for reminders. */
  reminders?: ReminderOptions;
  /** Tests: a fake for the model that reads images. */
  readImage?: ImageReader;
  /** Tests: fake services for adapters, and the clock. */
  adapters?: AdapterOptions;
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
  reminders: reminderOptions,
  readImage,
  adapters: adapterOptions,
}: AppOptions) {
  const app = new Hono();
  const secrets = SecretBox.load(dataDir, secret);
  const settings = new SettingsStore(db, secrets, settingsEnv);
  const jobs = new JobRunner(db, settings);
  jobs.register('organize', organizeJob(db));
  jobs.register('research', researchJob(db, importAllowPrivate));
  const semantic = new SemanticIndex(db, settings, embedder, semanticQuietMs);
  const reminders = new ReminderService(db, settings, reminderOptions);
  const attachmentText = new AttachmentReader(db, dataDir, settings, readImage);
  const adapters = new AdapterService(db, settings, secrets, adapterOptions);
  // The linked Telegram chat talks to the chat assistant (a conversation of its own).
  const chatDeps = { db, settings, jobs, semantic };
  reminders.useChat({
    ask: async (userId, text) => {
      const username = db.select({ username: users.username }).from(users).where(eq(users.id, userId)).get()?.username ?? 'you';
      return (await runChat(chatDeps, { userId, username, channel: 'telegram', text })).content;
    },
    reset: (userId) => resetChat(db, userId, 'telegram'),
    transcribe: async (userId, audio) => {
      const service = settings.transcription(userId);
      return service ? transcribe(service, audio) : null;
    },
  });
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
  // Attachment downloads set their own, stricter sandbox policy (also through a shared link).
  const download = /^\/api\/(attachments|public\/shares\/[^/]+\/attachments)\//;
  app.use('*', (c, next) => (download.test(c.req.path) ? next() : headers(c, next)));

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
  // Uploads set their own limits.
  const ownLimit = (path: string) => path.startsWith('/api/attachments') || path === '/api/import/vault/preview';
  app.use('/api/*', (c, next) => (ownLimit(c.req.path) ? next() : jsonLimit(c, next)));

  // Signed in by session, or by API token where scripts may reach (not settings with their
  // keys, backups with the key file, sign-in security, or the tokens themselves).
  const auth = requireAuth(db, secureCookies, tokenSignIn(db));
  const sessionOnly = requireAuth(db, secureCookies);
  app.get('/api/health', (c) => c.json({ ok: true }));
  // Calendar apps fetch without a session: the token in the address signs them in.
  app.route('/api/calendar', calendarRoutes(db, settings));
  // Read-only links: the token in the address is the key, no account needed.
  app.route('/api/public/shares', publicShareRoutes(db, dataDir));
  app.route('/api/auth', authRoutes(db, secureCookies, secrets));
  for (const area of ['notebooks', 'pages', 'tags', 'search', 'attachments', 'import', 'trash', 'export', 'jobs', 'ai', 'graph', 'daily', 'tasks', 'semantic', 'system', 'chat']) {
    app.use(`/api/${area}`, auth);
    app.use(`/api/${area}/*`, auth);
  }
  for (const area of ['settings', 'backups', 'tokens', 'security', 'shares', 'reminders', 'adapters']) {
    app.use(`/api/${area}`, sessionOnly);
    app.use(`/api/${area}/*`, sessionOnly);
  }
  app.route('/api/notebooks', notebookRoutes(db));
  app.route('/api/pages', pageRoutes(db));
  app.route('/api/pages', mentionRoutes(db));
  app.route('/api/tags', tagRoutes(db));
  app.route('/api/search', searchRoutes(db, attachmentText));
  app.route(
    '/api/attachments',
    attachmentRoutes(db, dataDir, () => void attachmentText.poke(), (userId) => settings.transcription(userId)),
  );
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
  app.route('/api/security', securityRoutes(db, secrets));
  app.route('/api/shares', shareRoutes(db, secrets));
  app.route('/api/reminders', reminderRoutes(reminders));
  app.route('/api/adapters', adapterRoutes(adapters));
  app.route('/api/chat', chatRoutes(chatDeps));
  app.route('/api/ai', aiRoutes(db, jobs));
  app.route('/api/ai', askRoutes(db, settings, semantic));
  app.route('/api/ai', assistantRoutes(db, settings, semantic, importAllowPrivate));
  app.route('/api/ai', insightRoutes(db, settings, semantic));
  app.route('/api/ai', layoutRoutes(db, settings));
  app.route('/api/import', importRoutes({ db, dataDir, settings, allowPrivate: importAllowPrivate }));
  app.route('/api/import/vault', vaultRoutes(db, dataDir, () => void attachmentText.poke()));
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
          // Excalidraw's fonts change only with Excalidraw itself.
          c.header('Cache-Control', path.includes('/excalidraw/fonts/') ? 'public, max-age=604800' : 'no-cache');
          if (path.endsWith('.webmanifest')) c.header('Content-Type', 'application/manifest+json');
        },
      }),
    );
    // SPA fallback: client-side routes all render index.html.
    app.get('*', (c) => {
      c.header('Cache-Control', 'no-cache');
      // Shared links are for the people they are sent to, not for search engines.
      if (c.req.path.startsWith('/s/')) c.header('X-Robots-Tag', 'noindex, nofollow');
      return c.html(indexHtml);
    });
  }

  return Object.assign(app, { jobs, semantic, backups, reminders, attachmentText, adapters });
}
