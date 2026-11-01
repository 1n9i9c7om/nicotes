import { randomBytes } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import {
  API_TOKEN_PREFIX,
  apiTokenCreateSchema,
  type ApiToken,
  type ApiTokenScope,
  type CreatedApiToken,
  type User,
} from '@nicotes/shared';
import { hashToken, LoginLimiter, type AppEnv } from './auth.js';
import type { Db } from './db/index.js';
import { apiTokens, users } from './db/schema.js';
import { clientIp, notFound, readJson } from './http.js';
import { newId } from './ids.js';

/** "Last used" is written at most this often per token, not on every request. */
const LAST_USED_EVERY_MS = 60_000;

type Row = typeof apiTokens.$inferSelect;

const toApiToken = (r: Row): ApiToken => ({
  id: r.id,
  name: r.name,
  scope: r.scope as ApiTokenScope,
  hint: r.hint,
  createdAt: r.createdAt,
  lastUsedAt: r.lastUsedAt,
  expiresAt: r.expiresAt,
});

/** The token of an `Authorization: Bearer …` header; null without one. */
export function bearerToken(c: Context): string | null {
  const header = c.req.header('authorization');
  const match = header?.match(/^Bearer\s+(\S+)$/i);
  return match ? match[1]! : null;
}

/** The user and scope a token grants, or null for an unknown, malformed or expired one. */
export function tokenAccess(db: Db, token: string): { user: User; scope: ApiTokenScope } | null {
  if (!token.startsWith(API_TOKEN_PREFIX)) return null;
  const row = db
    .select({ id: apiTokens.id, scope: apiTokens.scope, expiresAt: apiTokens.expiresAt, lastUsedAt: apiTokens.lastUsedAt, userId: users.id, username: users.username })
    .from(apiTokens)
    .innerJoin(users, eq(users.id, apiTokens.userId))
    .where(eq(apiTokens.tokenHash, hashToken(token)))
    .get();
  const now = Date.now();
  if (!row || (row.expiresAt !== null && row.expiresAt < now)) return null;
  if (row.lastUsedAt === null || now - row.lastUsedAt > LAST_USED_EVERY_MS) {
    db.update(apiTokens).set({ lastUsedAt: now }).where(eq(apiTokens.id, row.id)).run();
  }
  return { user: { id: row.userId, username: row.username }, scope: row.scope as ApiTokenScope };
}

/**
 * Signs requests in with their bearer token: returns false when a request has none, throws
 * for a wrong one. Read-only tokens may only use GET and HEAD. Wrong tokens count per IP,
 * like failed sign-ins, so they cannot be guessed.
 */
export function tokenSignIn(db: Db) {
  const failures = new LoginLimiter(20);
  return (c: Context<AppEnv>): boolean => {
    const token = bearerToken(c);
    if (token === null) return false;
    const key = clientIp(c);
    if (failures.isBlocked(key)) throw new HTTPException(429, { message: 'Too many wrong API tokens, try again later' });
    const access = tokenAccess(db, token);
    if (!access) {
      failures.fail(key);
      throw new HTTPException(401, { message: 'Unknown or expired API token' });
    }
    if (access.scope === 'read' && !['GET', 'HEAD'].includes(c.req.method)) {
      throw new HTTPException(403, { message: 'This API token may only read' });
    }
    c.set('user', access.user);
    return true;
  };
}

export function tokenRoutes(db: Db) {
  return new Hono<AppEnv>()
    .get('/', (c) =>
      c.json(
        db
          .select()
          .from(apiTokens)
          .where(eq(apiTokens.userId, c.var.user.id))
          .orderBy(desc(apiTokens.createdAt))
          .all()
          .map(toApiToken) satisfies ApiToken[],
      ),
    )
    .post('/', async (c) => {
      const input = await readJson(c, apiTokenCreateSchema);
      const token = `${API_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
      const now = Date.now();
      const row: Row = {
        id: newId(),
        userId: c.var.user.id,
        name: input.name,
        tokenHash: hashToken(token),
        hint: token.slice(-4),
        scope: input.scope,
        createdAt: now,
        lastUsedAt: null,
        expiresAt: input.expiresInDays ? now + input.expiresInDays * 24 * 60 * 60 * 1000 : null,
      };
      db.insert(apiTokens).values(row).run();
      return c.json({ token, info: toApiToken(row) } satisfies CreatedApiToken, 201);
    })
    .delete('/:id', (c) => {
      const result = db
        .delete(apiTokens)
        .where(and(eq(apiTokens.id, c.req.param('id')), eq(apiTokens.userId, c.var.user.id)))
        .run();
      if (result.changes === 0) throw notFound('Token');
      return c.body(null, 204);
    });
}
