import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { HTTPException } from 'hono/http-exception';
import { secureHeaders } from 'hono/secure-headers';
import { requireAuth } from './auth.js';
import type { Db } from './db/index.js';
import { authRoutes } from './routes/auth.js';
import { notebookRoutes } from './routes/notebooks.js';
import { pageRoutes } from './routes/pages.js';

export interface AppOptions {
  db: Db;
  secureCookies: boolean;
  /** Directory with the built web app; omitted in tests. */
  webDir?: string;
}

export function createApp({ db, secureCookies, webDir }: AppOptions) {
  const app = new Hono();

  app.onError((err, c) => {
    if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
    console.error(err);
    return c.json({ error: 'Internal server error' }, 500);
  });

  app.use(
    '*',
    secureHeaders({
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
        frameAncestors: ["'none'"],
      },
    }),
  );

  // CSRF defence: state-changing API calls must be JSON (or bodiless). Cross-site forms
  // cannot send application/json without a CORS preflight, which this server never allows.
  app.use('/api/*', async (c, next) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
      const type = c.req.header('content-type');
      if (type && !type.toLowerCase().startsWith('application/json')) {
        throw new HTTPException(415, { message: 'Expected application/json' });
      }
    }
    await next();
  });
  app.use('/api/*', bodyLimit({ maxSize: 10 * 1024 * 1024 }));

  const auth = requireAuth(db, secureCookies);
  app.get('/api/health', (c) => c.json({ ok: true }));
  app.route('/api/auth', authRoutes(db, secureCookies));
  app.use('/api/notebooks/*', auth);
  app.use('/api/pages/*', auth);
  app.route('/api/notebooks', notebookRoutes(db));
  app.route('/api/pages', pageRoutes(db));
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
    app.use('*', serveStatic({ root: webDir }));
    // SPA fallback: client-side routes all render index.html.
    app.get('*', (c) => {
      c.header('Cache-Control', 'no-cache');
      return c.html(indexHtml);
    });
  }

  return app;
}
