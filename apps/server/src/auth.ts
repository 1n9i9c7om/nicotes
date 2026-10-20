import { createHash, randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import { eq, lt } from 'drizzle-orm';
import type { Context, MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { HTTPException } from 'hono/http-exception';
import type { User } from '@nicotes/shared';
import type { Db } from './db/index.js';
import { sessions, users } from './db/schema.js';
import { newId } from './ids.js';

export const SESSION_COOKIE = 'nicotes_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SESSION_RENEW_MS = 15 * 24 * 60 * 60 * 1000;

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

function scryptAsync(password: string, salt: Buffer, keylen: number, opts: ScryptOptions) {
  return new Promise<Buffer>((resolve, reject) =>
    scrypt(password, salt, keylen, opts, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, SCRYPT.keylen, SCRYPT);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), key.toString('base64')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algo, n, r, p, salt, hash] = stored.split('$');
  if (algo !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const key = await scryptAsync(password, Buffer.from(salt, 'base64'), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
  });
  return timingSafeEqual(key, expected);
}

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

export function createUser(db: Db, username: string, passwordHash: string): User {
  const user = { id: newId(), username: username.toLowerCase(), passwordHash, createdAt: Date.now() };
  db.insert(users).values(user).run();
  return { id: user.id, username: user.username };
}

export function hasUsers(db: Db): boolean {
  return db.select({ id: users.id }).from(users).limit(1).get() !== undefined;
}

export function startSession(c: Context, db: Db, userId: string, secure: boolean) {
  const token = randomBytes(32).toString('base64url');
  const now = Date.now();
  db.insert(sessions)
    .values({ id: hashToken(token), userId, createdAt: now, expiresAt: now + SESSION_TTL_MS })
    .run();
  setSessionCookie(c, token, secure);
}

function setSessionCookie(c: Context, token: string, secure: boolean) {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'Lax',
    secure,
    path: '/',
    maxAge: SESSION_TTL_MS / 1000,
  });
}

export function endSession(c: Context, db: Db) {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) db.delete(sessions).where(eq(sessions.id, hashToken(token))).run();
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
}

/** Resolves the session cookie to a user, renewing sessions that are past half their lifetime. */
export function sessionUser(c: Context, db: Db, secure: boolean): User | null {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return null;
  const id = hashToken(token);
  const row = db
    .select({ id: users.id, username: users.username, expiresAt: sessions.expiresAt })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(eq(sessions.id, id))
    .get();
  const now = Date.now();
  if (!row || row.expiresAt < now) {
    if (row) db.delete(sessions).where(eq(sessions.id, id)).run();
    return null;
  }
  if (row.expiresAt - now < SESSION_RENEW_MS) {
    db.update(sessions).set({ expiresAt: now + SESSION_TTL_MS }).where(eq(sessions.id, id)).run();
    setSessionCookie(c, token, secure);
  }
  return { id: row.id, username: row.username };
}

export function purgeExpiredSessions(db: Db) {
  db.delete(sessions).where(lt(sessions.expiresAt, Date.now())).run();
}

export type AppEnv = { Variables: { user: User } };

export function requireAuth(db: Db, secure: boolean): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const user = sessionUser(c, db, secure);
    if (!user) throw new HTTPException(401, { message: 'Not signed in' });
    c.set('user', user);
    await next();
  };
}

/** Small in-memory limiter for failed logins, keyed by IP + username. */
export class LoginLimiter {
  private failures = new Map<string, { count: number; resetAt: number }>();
  constructor(
    private maxFailures = 10,
    private windowMs = 15 * 60 * 1000,
  ) {}

  isBlocked(key: string): boolean {
    const entry = this.failures.get(key);
    if (!entry) return false;
    if (entry.resetAt < Date.now()) {
      this.failures.delete(key);
      return false;
    }
    return entry.count >= this.maxFailures;
  }

  fail(key: string) {
    const now = Date.now();
    const entry = this.failures.get(key);
    if (!entry || entry.resetAt < now) this.failures.set(key, { count: 1, resetAt: now + this.windowMs });
    else entry.count++;
  }

  reset(key: string) {
    this.failures.delete(key);
  }
}
