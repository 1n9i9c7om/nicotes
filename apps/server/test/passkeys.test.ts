import { describe, expect, it } from 'vitest';
import type { Passkey, PasskeyOptions, SecurityStatus, TotpSetup, TwoFactorChallenge, User } from '@nicotes/shared';
import { base32Decode, totpCode, totpStep } from '../src/twoFactor.js';
import { setup } from './helpers.js';
import { SoftAuthenticator } from './webauthn.js';

// app.request() without an Origin header: the page is at http://localhost.
const ORIGIN = 'http://localhost';

interface CreationOptions {
  challenge: string;
  rp: { id: string; name: string };
  user: { id: string; name: string };
  excludeCredentials: { id: string }[];
  authenticatorSelection: { residentKey: string; userVerification: string };
}
interface RequestOptions {
  challenge: string;
  rpId: string;
  allowCredentials?: { id: string }[];
  userVerification: string;
}

async function withPasskey(backedUp = false) {
  const api = setup();
  await api.call('POST', '/api/auth/setup', { username: 'nico', password: 'secret-pass' });
  await api.call('POST', '/api/security/confirm', { password: 'secret-pass' });
  const authenticator = new SoftAuthenticator(backedUp);
  const { flow, options } = (await api.call<PasskeyOptions<CreationOptions>>('POST', '/api/security/passkeys/options')).body;
  const created = await api.call<Passkey>('POST', '/api/security/passkeys', {
    name: 'Laptop',
    flow,
    response: authenticator.register(options, ORIGIN),
  });
  expect(created.status).toBe(201);
  return { api, authenticator, passkey: created.body, options };
}

async function signInWithPasskey(api: ReturnType<typeof setup>, authenticator: SoftAuthenticator, ticket?: string, origin = ORIGIN) {
  const { flow, options } = (await api.call<PasskeyOptions<RequestOptions>>('POST', '/api/auth/passkey/options', { ticket })).body;
  return api.call<User & { error?: string }>('POST', '/api/auth/passkey', { flow, response: authenticator.authenticate(options, origin) });
}

describe('passkeys', () => {
  it('are created for this host and sign in without a password', async () => {
    const { api, authenticator, passkey, options } = await withPasskey(true);
    expect(options.rp).toEqual({ id: 'localhost', name: 'Nicotes' });
    expect(options.user.name).toBe('nico');
    expect(options.authenticatorSelection).toMatchObject({ residentKey: 'required', userVerification: 'required' });
    expect(passkey).toEqual({ id: expect.any(String), name: 'Laptop', backedUp: true, createdAt: expect.any(Number), lastUsedAt: null });

    // The same device is not offered a second passkey for this account.
    const again = (await api.call<PasskeyOptions<CreationOptions>>('POST', '/api/security/passkeys/options')).body;
    expect(again.options.excludeCredentials.map((c) => c.id)).toEqual([authenticator.credentialId]);

    api.logout();
    const open = (await api.call<PasskeyOptions<RequestOptions>>('POST', '/api/auth/passkey/options', {})).body;
    expect(open.options.allowCredentials ?? []).toEqual([]); // any passkey the device has for this site
    expect(open.options.userVerification).toBe('required');
    const res = await signInWithPasskey(api, authenticator);
    expect(res.status).toBe(200);
    expect(res.body.username).toBe('nico');
    expect((await api.call('GET', '/api/notebooks')).status).toBe(200);
    const listed = (await api.call<SecurityStatus>('GET', '/api/security')).body.passkeys;
    expect(listed[0]?.lastUsedAt).toEqual(expect.any(Number));
  });

  it('stand in for the code when two-step sign-in is on', async () => {
    const { api, authenticator } = await withPasskey();
    const { secret } = (await api.call<TotpSetup>('POST', '/api/security/totp')).body;
    await api.call('POST', '/api/security/totp/enable', { code: totpCode(base32Decode(secret), totpStep()) });
    api.logout();

    const challenge = (await api.call<TwoFactorChallenge>('POST', '/api/auth/login', { username: 'nico', password: 'secret-pass' })).body;
    expect(challenge.passkey).toBe(true);
    const { options } = (await api.call<PasskeyOptions<RequestOptions>>('POST', '/api/auth/passkey/options', { ticket: challenge.ticket })).body;
    expect(options.allowCredentials?.map((c) => c.id)).toEqual([authenticator.credentialId]);

    expect((await signInWithPasskey(api, authenticator, challenge.ticket)).status).toBe(200);
    // The ticket is used up.
    expect((await api.call('POST', '/api/auth/passkey/options', { ticket: challenge.ticket })).status).toBe(401);
  });

  it('refuse answers made for another site, unknown keys and replays', async () => {
    const { api, authenticator } = await withPasskey();
    api.logout();

    // A phishing page signs for its own origin.
    const phished = await signInWithPasskey(api, authenticator, undefined, 'https://nicotes.example.evil');
    expect(phished.status).toBe(401);

    // A passkey created for localhost does not sign in at another host name.
    const optionsRes = await api.request('/api/auth/passkey/options', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1' },
      body: '{}',
    });
    const elsewhere = (await optionsRes.json()) as PasskeyOptions<RequestOptions>;
    expect(elsewhere.options.rpId).toBe('127.0.0.1');
    const wrongHost = await api.request('/api/auth/passkey', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1' },
      body: JSON.stringify({ flow: elsewhere.flow, response: authenticator.authenticate(elsewhere.options, 'http://127.0.0.1') }),
    });
    expect(wrongHost.status).toBe(401);

    expect((await signInWithPasskey(api, new SoftAuthenticator())).status).toBe(401);

    const { flow, options } = (await api.call<PasskeyOptions<RequestOptions>>('POST', '/api/auth/passkey/options', {})).body;
    const response = authenticator.authenticate(options, ORIGIN);
    expect((await api.call('POST', '/api/auth/passkey', { flow, response })).status).toBe(200);
    expect((await api.call('POST', '/api/auth/passkey', { flow, response })).status).toBe(401);
  });

  it('are removed with the password confirmed, and then stop working', async () => {
    const { api, authenticator, passkey } = await withPasskey();
    expect((await api.call('DELETE', `/api/security/passkeys/${passkey.id}`)).status).toBe(204);
    expect((await api.call('DELETE', `/api/security/passkeys/${passkey.id}`)).status).toBe(404);
    api.logout();
    expect((await signInWithPasskey(api, authenticator)).status).toBe(401);
  });
});
