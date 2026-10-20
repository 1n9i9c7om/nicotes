import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { createUser, hashPassword, hasUsers, purgeExpiredSessions } from './auth.js';
import { config } from './config.js';
import { openDb } from './db/index.js';

const db = openDb(config.dbFile, config.migrationsFolder);

if (!hasUsers(db) && config.adminUser && config.adminPassword) {
  createUser(db, config.adminUser, await hashPassword(config.adminPassword));
  console.log(`Created account "${config.adminUser}" from NICOTES_ADMIN_USER`);
}

purgeExpiredSessions(db);
setInterval(() => purgeExpiredSessions(db), 60 * 60 * 1000).unref();

const app = createApp({ db, secureCookies: config.secureCookies, webDir: config.webDir });

const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`Nicotes listening on http://localhost:${info.port} (data: ${config.dataDir})`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close();
    db.$client.close();
    process.exit(0);
  });
}
