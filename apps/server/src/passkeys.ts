import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransport,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { and, desc, eq } from 'drizzle-orm';
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { Passkey, User } from '@nicotes/shared';
import type { Db } from './db/index.js';
import { passkeys } from './db/schema.js';
import { requestOrigin } from './http.js';
import { newId } from './ids.js';

/** Who the browser thinks it talks to: passkeys belong to this host name. */
export interface RelyingParty {
  id: string;
  origin: string;
}

/**
 * The page's origin, as the browser sends it with every POST; the passkey's host name is
 * taken from it. A phishing site on another host gets passkeys for its own name, which
 * never sign in here.
 */
export function relyingParty(c: Context): RelyingParty {
  const origin = c.req.header('origin') ?? requestOrigin(c);
  try {
    return { id: new URL(origin).hostname, origin };
  } catch {
    throw new HTTPException(400, { message: 'Passkeys need a page address' });
  }
}

/**
 * EdDSA, ES256 and RS256: what authenticators use. Listed, so the library does not probe Node
 * for experimental post-quantum algorithms (which logs warnings).
 */
const ALGORITHMS = [-8, -7, -257];

const transportsOf = (stored: string | null) => (stored ? (JSON.parse(stored) as AuthenticatorTransport[]) : undefined);

const toPasskey = (row: typeof passkeys.$inferSelect): Passkey => ({
  id: row.id,
  name: row.name,
  backedUp: row.backedUp,
  createdAt: row.createdAt,
  lastUsedAt: row.lastUsedAt,
});

export const listPasskeys = (db: Db, userId: string) =>
  db.select().from(passkeys).where(eq(passkeys.userId, userId)).orderBy(desc(passkeys.createdAt)).all().map(toPasskey);

export const hasPasskeys = (db: Db, userId: string) =>
  db.select({ id: passkeys.id }).from(passkeys).where(eq(passkeys.userId, userId)).limit(1).get() !== undefined;

/** What the browser needs to create a passkey; ones the device already has are excluded. */
export function registrationOptions(db: Db, user: User, rp: RelyingParty) {
  const existing = db.select().from(passkeys).where(eq(passkeys.userId, user.id)).all();
  return generateRegistrationOptions({
    rpName: 'Nicotes',
    rpID: rp.id,
    userName: user.username,
    // Stable per account, so a device keeps one passkey per account rather than piling up.
    userID: new TextEncoder().encode(user.id),
    attestationType: 'none',
    supportedAlgorithmIDs: ALGORITHMS,
    excludeCredentials: existing.map((p) => ({ id: p.credentialId, transports: transportsOf(p.transports) })),
    // Discoverable, so it signs in without a username; verified (fingerprint, face, PIN),
    // so it counts as both steps.
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
  });
}

const rejected = (err: unknown) =>
  new HTTPException(400, { message: `The passkey was not accepted: ${err instanceof Error ? err.message : String(err)}` });

export async function savePasskey(
  db: Db,
  userId: string,
  name: string,
  response: RegistrationResponseJSON,
  challenge: string,
  rp: RelyingParty,
): Promise<Passkey> {
  let result;
  try {
    result = await verifyRegistrationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: rp.origin,
      expectedRPID: rp.id,
      requireUserVerification: true,
      supportedAlgorithmIDs: ALGORITHMS,
    });
  } catch (err) {
    throw rejected(err);
  }
  if (!result.verified) throw rejected('it could not be verified');
  const { credential, credentialBackedUp } = result.registrationInfo;
  const row = {
    id: newId(),
    userId,
    name,
    credentialId: credential.id,
    publicKey: Buffer.from(credential.publicKey).toString('base64url'),
    counter: credential.counter,
    transports: credential.transports ? JSON.stringify(credential.transports) : null,
    rpId: rp.id,
    backedUp: credentialBackedUp,
    createdAt: Date.now(),
    lastUsedAt: null,
  };
  try {
    db.insert(passkeys).values(row).run();
  } catch {
    throw new HTTPException(409, { message: 'This passkey is already registered' });
  }
  return toPasskey(row);
}

/** Options for signing in: any passkey of this site, or only the user's for a second step. */
export function authenticationOptions(db: Db, rp: RelyingParty, userId?: string) {
  const allowed = userId
    ? db.select().from(passkeys).where(and(eq(passkeys.userId, userId), eq(passkeys.rpId, rp.id))).all()
    : [];
  return generateAuthenticationOptions({
    rpID: rp.id,
    userVerification: 'required',
    allowCredentials: allowed.map((p) => ({ id: p.credentialId, transports: transportsOf(p.transports) })),
  });
}

/** Checks a passkey sign-in and returns the account it belongs to. */
export async function verifyPasskey(
  db: Db,
  response: AuthenticationResponseJSON,
  challenge: string,
  rp: RelyingParty,
  userId?: string,
): Promise<string> {
  const unknown = new HTTPException(401, { message: 'This passkey does not belong to an account here' });
  const row = db.select().from(passkeys).where(eq(passkeys.credentialId, response.id)).get();
  if (!row || row.rpId !== rp.id || (userId && row.userId !== userId)) throw unknown;
  let result;
  try {
    result = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: rp.origin,
      expectedRPID: rp.id,
      credential: {
        id: row.credentialId,
        publicKey: new Uint8Array(Buffer.from(row.publicKey, 'base64url')),
        counter: row.counter,
        transports: transportsOf(row.transports),
      },
      requireUserVerification: true,
    });
  } catch (err) {
    throw new HTTPException(401, { message: `Passkey sign-in failed: ${err instanceof Error ? err.message : String(err)}` });
  }
  if (!result.verified) throw unknown;
  db.update(passkeys)
    .set({ counter: result.authenticationInfo.newCounter, lastUsedAt: Date.now() })
    .where(eq(passkeys.id, row.id))
    .run();
  return row.userId;
}

export function deletePasskey(db: Db, userId: string, id: string): boolean {
  return db.delete(passkeys).where(and(eq(passkeys.id, id), eq(passkeys.userId, userId))).run().changes > 0;
}
