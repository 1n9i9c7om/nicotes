import {
  browserSupportsWebAuthn,
  startAuthentication,
  startRegistration,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/browser';
import type { Passkey, PasskeyOptions, User } from '@nicotes/shared';
import { api } from './api';

/** Passkeys need a browser that has them, on HTTPS (or localhost). */
export const passkeysSupported = () => window.isSecureContext && browserSupportsWebAuthn();

/** The browser's errors, in words: closing the prompt is the common one. */
function explain(err: unknown): Error {
  const name = (err as { name?: string; code?: string }).name;
  const code = (err as { code?: string }).code;
  if (code === 'ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED' || name === 'InvalidStateError') {
    return new Error('This device already has a passkey for your account.');
  }
  if (name === 'NotAllowedError' || name === 'AbortError') return new Error('The passkey prompt was closed or timed out.');
  return err instanceof Error ? err : new Error(String(err));
}

/** Signs in with a passkey: on its own, or as the second step with the ticket from the password. */
export async function signInWithPasskey(ticket?: string): Promise<User> {
  const { flow, options } = await api.post<PasskeyOptions<PublicKeyCredentialRequestOptionsJSON>>(
    '/auth/passkey/options',
    ticket ? { ticket } : {},
  );
  let response;
  try {
    response = await startAuthentication({ optionsJSON: options });
  } catch (err) {
    throw explain(err);
  }
  return api.post<User>('/auth/passkey', { flow, response });
}

export async function createPasskey(name: string): Promise<Passkey> {
  const { flow, options } = await api.post<PasskeyOptions<PublicKeyCredentialCreationOptionsJSON>>('/security/passkeys/options');
  let response;
  try {
    response = await startRegistration({ optionsJSON: options });
  } catch (err) {
    throw explain(err);
  }
  return api.post<Passkey>('/security/passkeys', { name, flow, response });
}
