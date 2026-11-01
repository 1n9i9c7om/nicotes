import { eq } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import {
  passkeyCreateSchema,
  passwordConfirmSchema,
  totpEnableSchema,
  type RecoveryCodes,
  type SecurityStatus,
  type TotpSetup,
} from '@nicotes/shared';
import type { RegistrationResponseJSON } from '@simplewebauthn/server';
import { LoginLimiter, sessionId, verifyPassword, type AppEnv } from '../auth.js';
import type { Db } from '../db/index.js';
import { twoFactor, users } from '../db/schema.js';
import { readJson } from '../http.js';
import { deletePasskey, listPasskeys, registrationOptions, relyingParty, savePasskey, type RelyingParty } from '../passkeys.js';
import { Pending } from '../pending.js';
import type { SecretBox } from '../secrets.js';
import {
  base32Decode,
  disableTotp,
  enableTotp,
  matchTotp,
  newRecoveryCodes,
  newTotpSecret,
  recoveryCodesLeft,
  totpEnabled,
  totpUri,
} from '../twoFactor.js';

/** How long the password, entered again, unlocks these settings. */
const CONFIRM_MS = 10 * 60 * 1000;

/**
 * /api/security (session only): two-step sign-in and passkeys. Changes need the password
 * again first, so a session left open somewhere cannot lock the owner out or add a way in.
 */
export function securityRoutes(db: Db, secrets: SecretBox) {
  const confirmed = new Pending<string>(CONFIRM_MS);
  const wrongPasswords = new LoginLimiter(10);
  // Secrets shown in the QR code, waiting for their first code.
  const setups = new Pending<string>(15 * 60 * 1000);
  const registrations = new Pending<{ userId: string; challenge: string; rp: RelyingParty }>(5 * 60 * 1000);

  const isConfirmed = (c: Context<AppEnv>) => {
    const id = sessionId(c);
    return id !== null && confirmed.get(id) === c.get('user').id;
  };
  const requireConfirmed = (c: Context<AppEnv>) => {
    if (!isConfirmed(c)) throw new HTTPException(403, { message: 'Enter your password first' });
  };

  return new Hono<AppEnv>()
    .get('/', (c) => {
      const userId = c.get('user').id;
      const row = db.select({ enabledAt: twoFactor.enabledAt }).from(twoFactor).where(eq(twoFactor.userId, userId)).get();
      const status: SecurityStatus = {
        confirmed: isConfirmed(c),
        totp: { enabled: row !== undefined, enabledAt: row?.enabledAt ?? null },
        recoveryCodesLeft: recoveryCodesLeft(db, userId),
        passkeys: listPasskeys(db, userId),
      };
      return c.json(status);
    })
    .post('/confirm', async (c) => {
      const { password } = await readJson(c, passwordConfirmSchema);
      const user = c.get('user');
      if (wrongPasswords.isBlocked(user.id)) throw new HTTPException(429, { message: 'Too many wrong passwords, try again later' });
      const row = db.select({ hash: users.passwordHash }).from(users).where(eq(users.id, user.id)).get();
      if (!row || !(await verifyPassword(password, row.hash))) {
        wrongPasswords.fail(user.id);
        throw new HTTPException(401, { message: 'Wrong password' });
      }
      wrongPasswords.reset(user.id);
      confirmed.put(user.id, sessionId(c)!);
      return c.body(null, 204);
    })

    // ---------- Authenticator app ----------
    .post('/totp', (c) => {
      requireConfirmed(c);
      const user = c.get('user');
      const secret = newTotpSecret();
      setups.put(secret, user.id);
      return c.json({ secret, uri: totpUri(secret, user.username) } satisfies TotpSetup);
    })
    .post('/totp/enable', async (c) => {
      requireConfirmed(c);
      const { code } = await readJson(c, totpEnableSchema);
      const userId = c.get('user').id;
      const secret = setups.get(userId);
      if (!secret) throw new HTTPException(409, { message: 'The setup timed out, start it again' });
      const step = matchTotp(base32Decode(secret), code);
      if (step === null) throw new HTTPException(400, { message: 'That code is not right. Check that the time on your phone is correct.' });
      enableTotp(db, secrets, userId, secret, step);
      setups.delete(userId);
      return c.json({ codes: newRecoveryCodes(db, userId) } satisfies RecoveryCodes);
    })
    .delete('/totp', (c) => {
      requireConfirmed(c);
      disableTotp(db, c.get('user').id);
      return c.body(null, 204);
    })
    .post('/recovery-codes', (c) => {
      requireConfirmed(c);
      const userId = c.get('user').id;
      if (!totpEnabled(db, userId)) throw new HTTPException(409, { message: 'Two-step sign-in is off' });
      return c.json({ codes: newRecoveryCodes(db, userId) } satisfies RecoveryCodes);
    })

    // ---------- Passkeys ----------
    .post('/passkeys/options', async (c) => {
      requireConfirmed(c);
      const user = c.get('user');
      const rp = relyingParty(c);
      const options = await registrationOptions(db, user, rp);
      const flow = registrations.put({ userId: user.id, challenge: options.challenge, rp });
      return c.json({ flow, options });
    })
    .post('/passkeys', async (c) => {
      requireConfirmed(c);
      const { name, flow, response } = await readJson(c, passkeyCreateSchema);
      const userId = c.get('user').id;
      const pending = registrations.take(flow);
      const rp = relyingParty(c);
      if (!pending || pending.userId !== userId || pending.rp.id !== rp.id) {
        throw new HTTPException(409, { message: 'That took too long, try again' });
      }
      const passkey = await savePasskey(db, userId, name, response as unknown as RegistrationResponseJSON, pending.challenge, rp);
      return c.json(passkey, 201);
    })
    .delete('/passkeys/:id', (c) => {
      requireConfirmed(c);
      if (!deletePasskey(db, c.get('user').id, c.req.param('id'))) throw new HTTPException(404, { message: 'Passkey not found' });
      return c.body(null, 204);
    });
}
