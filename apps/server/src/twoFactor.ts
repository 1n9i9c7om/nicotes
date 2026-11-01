import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { and, count, eq } from 'drizzle-orm';
import type { Db } from './db/index.js';
import { recoveryCodes, twoFactor } from './db/schema.js';
import type { SecretBox } from './secrets.js';

// ---------- TOTP (RFC 6238: HMAC-SHA1, 30-second steps, 6 digits) ----------

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_MS = 30_000;

export function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[\s=-]/g, '');
  const bytes: number[] = [];
  let bits = 0;
  let value = 0;
  for (const char of clean) {
    const index = BASE32.indexOf(char);
    if (index < 0) throw new Error('Not base32');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

export const totpStep = (now = Date.now()) => Math.floor(now / STEP_MS);

/** The code for one time step. */
export function totpCode(secret: Buffer, step: number, digits = 6): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac('sha1', secret).update(counter).digest();
  const offset = mac[mac.length - 1]! & 0xf;
  const number = (mac.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits;
  return number.toString().padStart(digits, '0');
}

/**
 * The step `code` belongs to, allowing one step either side for clocks that are a little
 * off; null when it matches none, or only steps up to `after` (codes already used).
 */
export function matchTotp(secret: Buffer, code: string, now = Date.now(), after = 0): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const current = totpStep(now);
  let match: number | null = null;
  for (const step of [current - 1, current, current + 1]) {
    // Compare every candidate, so timing does not tell which one matched.
    if (timingSafeEqual(Buffer.from(totpCode(secret, step)), Buffer.from(code)) && step > after) match = step;
  }
  return match;
}

export const newTotpSecret = () => base32Encode(randomBytes(20));

/** The address authenticator apps read from the QR code. */
export function totpUri(secret: string, username: string, issuer = 'Nicotes'): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(username)}`;
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

// ---------- Recovery codes ----------

// No 0/o, 1/l/i: easy to read off paper.
const RECOVERY_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const RECOVERY_COUNT = 10;

const normaliseRecovery = (code: string) => code.toLowerCase().replace(/[^a-z0-9]/g, '');
const hashRecovery = (code: string) => createHash('sha256').update(normaliseRecovery(code)).digest('hex');

/** Looks like a recovery code rather than six digits. */
export const isRecoveryCode = (code: string) => normaliseRecovery(code).length === 10 && !/^\d+$/.test(code.trim());

function recoveryCode(): string {
  let code = '';
  for (let i = 0; i < 10; i++) code += RECOVERY_ALPHABET[randomInt(RECOVERY_ALPHABET.length)];
  return `${code.slice(0, 5)}-${code.slice(5)}`;
}

/** Replaces the user's recovery codes; the codes themselves are only returned here. */
export function newRecoveryCodes(db: Db, userId: string): string[] {
  const codes = Array.from({ length: RECOVERY_COUNT }, recoveryCode);
  const now = Date.now();
  db.transaction((tx) => {
    tx.delete(recoveryCodes).where(eq(recoveryCodes.userId, userId)).run();
    tx.insert(recoveryCodes)
      .values(codes.map((code) => ({ codeHash: hashRecovery(code), userId, createdAt: now })))
      .run();
  });
  return codes;
}

/** Uses up a recovery code: true if it was one of the user's. */
export function useRecoveryCode(db: Db, userId: string, code: string): boolean {
  const deleted = db
    .delete(recoveryCodes)
    .where(and(eq(recoveryCodes.userId, userId), eq(recoveryCodes.codeHash, hashRecovery(code))))
    .run();
  return deleted.changes > 0;
}

export const recoveryCodesLeft = (db: Db, userId: string) =>
  db.select({ n: count() }).from(recoveryCodes).where(eq(recoveryCodes.userId, userId)).get()?.n ?? 0;

// ---------- Stored state ----------

export const totpEnabled = (db: Db, userId: string) =>
  db.select({ userId: twoFactor.userId }).from(twoFactor).where(eq(twoFactor.userId, userId)).get() !== undefined;

/**
 * Checks a code from the authenticator app and remembers its step, so it cannot be used a
 * second time. False also when the secret cannot be decrypted (NICOTES_SECRET changed).
 */
export function checkTotp(db: Db, secrets: SecretBox, userId: string, code: string, now = Date.now()): boolean {
  const row = db.select().from(twoFactor).where(eq(twoFactor.userId, userId)).get();
  const secret = row && secrets.decrypt(row.totpSecret);
  if (!row || !secret) return false;
  const step = matchTotp(base32Decode(secret), code, now, row.lastStep);
  if (step === null) return false;
  db.update(twoFactor).set({ lastStep: step }).where(eq(twoFactor.userId, userId)).run();
  return true;
}

export function enableTotp(db: Db, secrets: SecretBox, userId: string, secret: string, step: number) {
  const values = { totpSecret: secrets.encrypt(secret), lastStep: step, enabledAt: Date.now() };
  db.insert(twoFactor)
    .values({ userId, ...values })
    .onConflictDoUpdate({ target: twoFactor.userId, set: values })
    .run();
}

export function disableTotp(db: Db, userId: string) {
  db.transaction((tx) => {
    tx.delete(twoFactor).where(eq(twoFactor.userId, userId)).run();
    tx.delete(recoveryCodes).where(eq(recoveryCodes.userId, userId)).run();
  });
}

// ---------- Short-lived state ----------

/**
 * Values that live a few minutes in memory: sign-in tickets, secrets waiting for their first
 * code, WebAuthn challenges. Capped, so unauthenticated callers cannot fill the memory.
 */
export class Pending<T> {
  private entries = new Map<string, { value: T; expiresAt: number }>();
  constructor(
    private ttlMs: number,
    private max = 1000,
  ) {}

  /** Stores `value` under a new random id, or under `id` (replacing what was there). */
  put(value: T, id = randomBytes(24).toString('base64url')): string {
    const now = Date.now();
    for (const [key, entry] of this.entries) if (entry.expiresAt < now) this.entries.delete(key);
    this.entries.delete(id);
    while (this.entries.size >= this.max) this.entries.delete(this.entries.keys().next().value!);
    this.entries.set(id, { value, expiresAt: now + this.ttlMs });
    return id;
  }

  get(id: string): T | undefined {
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    if (entry.expiresAt < Date.now()) {
      this.entries.delete(id);
      return undefined;
    }
    return entry.value;
  }

  /** Gets and removes: for one-time values. */
  take(id: string): T | undefined {
    const value = this.get(id);
    this.entries.delete(id);
    return value;
  }

  delete(id: string) {
    this.entries.delete(id);
  }
}
