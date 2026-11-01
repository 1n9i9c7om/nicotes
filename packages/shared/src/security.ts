import { z } from 'zod';
import type { User } from './index';

/**
 * POST /api/auth/login when two-step sign-in is on: the password was right, now a code from
 * the authenticator app (or a recovery code, or a passkey) finishes signing in.
 */
export interface TwoFactorChallenge {
  twoFactor: true;
  /** Short-lived; goes with the code to POST /api/auth/login/code. */
  ticket: string;
  /** The account has passkeys, so one can stand in for the code. */
  passkey: boolean;
}
export type LoginResult = User | TwoFactorChallenge;

export const isTwoFactorChallenge = (r: LoginResult): r is TwoFactorChallenge => 'twoFactor' in r;

export const loginCodeSchema = z.object({
  ticket: z.string().min(1).max(100),
  /** Six digits from the app, or a recovery code ("abcde-fghij"). */
  code: z.string().trim().min(6).max(40),
});
export type LoginCode = z.infer<typeof loginCodeSchema>;

/** A browser's WebAuthn response, checked in full by the server's WebAuthn library. */
export const webAuthnResponseSchema = z
  .object({ id: z.string().min(1).max(1024), type: z.literal('public-key') })
  .passthrough();

/** POST /api/auth/passkey/options: with a ticket, the passkey is the second step. */
export const passkeyOptionsSchema = z.object({ ticket: z.string().min(1).max(100).optional() });

export const passkeyLoginSchema = z.object({
  flow: z.string().min(1).max(100),
  response: webAuthnResponseSchema,
});

export interface Passkey {
  id: string;
  name: string;
  /** Synced between devices by a password manager or the operating system. */
  backedUp: boolean;
  createdAt: number;
  lastUsedAt: number | null;
}

export const passkeyCreateSchema = z.object({
  name: z.string().trim().min(1).max(80),
  flow: z.string().min(1).max(100),
  response: webAuthnResponseSchema,
});

/** GET /api/security */
export interface SecurityStatus {
  /**
   * The password was entered again in the last few minutes: until then, these settings can
   * be changed (POST /api/security/confirm).
   */
  confirmed: boolean;
  totp: { enabled: boolean; enabledAt: number | null };
  recoveryCodesLeft: number;
  passkeys: Passkey[];
}

/** POST /api/security/totp: a new secret to scan, active once a code from it is confirmed. */
export interface TotpSetup {
  /** Base32, for typing into the app by hand. */
  secret: string;
  /** otpauth:// address, for the QR code. */
  uri: string;
}

export const totpEnableSchema = z.object({ code: z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code') });

/** Turning two-step sign-in off, or new recovery codes, needs the password again. */
export const passwordConfirmSchema = z.object({ password: z.string().min(1).max(256) });

export interface RecoveryCodes {
  codes: string[];
}

/** WebAuthn options for the browser, plus the id that pairs them with the answer. */
export interface PasskeyOptions<T = unknown> {
  flow: string;
  options: T;
}
