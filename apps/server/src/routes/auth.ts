import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { credentialsSchema, loginSchema, type AuthStatus } from '@nicotes/shared';
import {
  createUser,
  endSession,
  hashPassword,
  hasUsers,
  LoginLimiter,
  sessionUser,
  startSession,
  verifyPassword,
} from '../auth.js';
import type { Db } from '../db/index.js';
import { users } from '../db/schema.js';
import { clientIp, readJson } from '../http.js';

// A fixed hash so unknown usernames cost as much time as wrong passwords.
const DUMMY_HASH =
  'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$' + Buffer.alloc(64).toString('base64');

export function authRoutes(db: Db, secure: boolean) {
  const limiter = new LoginLimiter();

  return new Hono()
    .get('/status', (c) => {
      const status: AuthStatus = { user: sessionUser(c, db, secure), setupRequired: !hasUsers(db) };
      return c.json(status);
    })
    .post('/setup', async (c) => {
      const { username, password } = await readJson(c, credentialsSchema);
      if (hasUsers(db)) throw new HTTPException(403, { message: 'Setup has already been completed' });
      const passwordHash = await hashPassword(password);
      // Re-check after the await: the check and the insert must not be separated by a yield.
      if (hasUsers(db)) throw new HTTPException(403, { message: 'Setup has already been completed' });
      const user = createUser(db, username, passwordHash);
      startSession(c, db, user.id, secure);
      return c.json(user, 201);
    })
    .post('/login', async (c) => {
      const { username, password } = await readJson(c, loginSchema);
      const key =`${clientIp(c)}|${username.toLowerCase()}`;
      if (limiter.isBlocked(key)) {
        throw new HTTPException(429, { message: 'Too many failed attempts, try again later' });
      }
      const row = db.select().from(users).where(eq(users.username, username.toLowerCase())).get();
      const ok = await verifyPassword(password, row?.passwordHash ?? DUMMY_HASH);
      if (!row || !ok) {
        limiter.fail(key);
        throw new HTTPException(401, { message: 'Wrong username or password' });
      }
      limiter.reset(key);
      startSession(c, db, row.id, secure);
      return c.json({ id: row.id, username: row.username });
    })
    .post('/logout', (c) => {
      endSession(c, db);
      return c.body(null, 204);
    });
}
