import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import {
  credentialsSchema,
  loginCodeSchema,
  loginSchema,
  passkeyLoginSchema,
  passkeyOptionsSchema,
  type AuthStatus,
  type TwoFactorChallenge,
  type User,
} from '@nicotes/shared';
import type { AuthenticationResponseJSON } from '@simplewebauthn/server';
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
import { authenticationOptions, hasPasskeys, relyingParty, verifyPasskey, type RelyingParty } from '../passkeys.js';
import type { SecretBox } from '../secrets.js';
import { Pending } from '../pending.js';
import { checkTotp, isRecoveryCode, totpEnabled, useRecoveryCode } from '../twoFactor.js';

// A fixed hash so unknown usernames cost as much time as wrong passwords.
const DUMMY_HASH =
  'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$' + Buffer.alloc(64).toString('base64');

/** Wrong codes per ticket before the password has to be entered again. */
const TICKET_ATTEMPTS = 5;

export function authRoutes(db: Db, secure: boolean, secrets: SecretBox) {
  const limiter = new LoginLimiter();
  // Six digits are guessable given enough tries, so wrong codes count per account, however
  // many tickets they come from: 10 per 6 hours. Recovery codes and passkeys still work.
  const codeFailures = new LoginLimiter(10, 6 * 60 * 60 * 1000);
  // The password was right; the second step has 5 minutes.
  const tickets = new Pending<{ userId: string; attempts: number }>(5 * 60 * 1000);
  const challenges = new Pending<{ challenge: string; rp: RelyingParty; userId?: string; ticket?: string }>(5 * 60 * 1000);
  const userById = (id: string): User => {
    const row = db.select({ id: users.id, username: users.username }).from(users).where(eq(users.id, id)).get();
    if (!row) throw new HTTPException(401, { message: 'This account no longer exists' });
    return row;
  };
  const expired = () => new HTTPException(401, { message: 'The sign-in took too long, enter your password again' });

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
      if (totpEnabled(db, row.id)) {
        const ticket = tickets.put({ userId: row.id, attempts: 0 });
        return c.json({ twoFactor: true, ticket, passkey: hasPasskeys(db, row.id) } satisfies TwoFactorChallenge);
      }
      startSession(c, db, row.id, secure);
      return c.json({ id: row.id, username: row.username });
    })
    // Second step: a code from the authenticator app, or a recovery code.
    .post('/login/code', async (c) => {
      const { ticket, code } = await readJson(c, loginCodeSchema);
      const pending = tickets.get(ticket);
      if (!pending) throw expired();
      const recovery = isRecoveryCode(code);
      if (!recovery && codeFailures.isBlocked(pending.userId)) {
        throw new HTTPException(429, { message: 'Too many wrong codes. Try again later, or use a recovery code or a passkey.' });
      }
      const ok = recovery
        ? useRecoveryCode(db, pending.userId, code)
        : checkTotp(db, secrets, pending.userId, code.replace(/\s/g, ''));
      if (!ok) {
        if (!recovery) codeFailures.fail(pending.userId);
        if (++pending.attempts >= TICKET_ATTEMPTS) tickets.delete(ticket);
        throw new HTTPException(401, { message: recovery ? 'That recovery code is wrong or used up' : 'Wrong code' });
      }
      tickets.delete(ticket);
      codeFailures.reset(pending.userId);
      startSession(c, db, pending.userId, secure);
      return c.json(userById(pending.userId));
    })
    // Passkeys: on their own (they verify the person, so they count as both steps), or with
    // a ticket in place of the code.
    .post('/passkey/options', async (c) => {
      const { ticket } = await readJson(c, passkeyOptionsSchema);
      const userId = ticket ? tickets.get(ticket)?.userId : undefined;
      if (ticket && !userId) throw expired();
      const rp = relyingParty(c);
      const options = await authenticationOptions(db, rp, userId);
      const flow = challenges.put({ challenge: options.challenge, rp, userId, ticket });
      return c.json({ flow, options });
    })
    .post('/passkey', async (c) => {
      const { flow, response } = await readJson(c, passkeyLoginSchema);
      const pending = challenges.take(flow);
      if (!pending) throw expired();
      const rp = relyingParty(c);
      if (rp.id !== pending.rp.id) throw expired();
      const userId = await verifyPasskey(db, response as unknown as AuthenticationResponseJSON, pending.challenge, rp, pending.userId);
      if (pending.ticket) tickets.delete(pending.ticket);
      startSession(c, db, userId, secure);
      return c.json(userById(userId));
    })
    .post('/logout', (c) => {
      endSession(c, db);
      return c.body(null, 204);
    });
}
