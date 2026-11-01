import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LoginResult, RecoveryCodes, SecurityStatus, TotpSetup, TwoFactorChallenge, User } from '@nicotes/shared';
import { base32Decode, base32Encode, matchTotp, totpCode, totpStep } from '../src/twoFactor.js';
import { setup } from './helpers.js';

const rfcSecret = Buffer.from('12345678901234567890');

describe('TOTP', () => {
  it('matches the RFC 6238 test values', () => {
    const at = (seconds: number) => totpCode(rfcSecret, totpStep(seconds * 1000));
    expect(at(59)).toBe('287082');
    expect(at(1111111109)).toBe('081804');
    expect(at(1234567890)).toBe('005924');
    expect(at(2000000000)).toBe('279037');
  });

  it('encodes secrets in base32, as authenticator apps expect', () => {
    expect(base32Encode(rfcSecret)).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    expect(base32Decode('gezd gnbv-gy3tqojqgezdgnbvgy3tqojq')).toEqual(rfcSecret);
  });

  it('allows one step of clock drift, but no code twice', () => {
    const now = 1_800_000_000_000;
    const step = totpStep(now);
    expect(matchTotp(rfcSecret, totpCode(rfcSecret, step - 1), now)).toBe(step - 1);
    expect(matchTotp(rfcSecret, totpCode(rfcSecret, step + 1), now)).toBe(step + 1);
    expect(matchTotp(rfcSecret, totpCode(rfcSecret, step + 2), now)).toBeNull();
    expect(matchTotp(rfcSecret, totpCode(rfcSecret, step), now, step)).toBeNull();
    expect(matchTotp(rfcSecret, '12345', now)).toBeNull();
  });
});

describe('two-step sign-in', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_800_000_000_000);
  });
  afterEach(() => vi.useRealTimers());

  const codeAt = (secret: string, offset = 0) => totpCode(base32Decode(secret), totpStep() + offset);

  async function withTwoFactor() {
    const api = setup();
    await api.call('POST', '/api/auth/setup', { username: 'nico', password: 'secret-pass' });
    expect((await api.call('POST', '/api/security/confirm', { password: 'secret-pass' })).status).toBe(204);
    const { secret, uri } = (await api.call<TotpSetup>('POST', '/api/security/totp')).body;
    expect(uri).toBe(`otpauth://totp/Nicotes:nico?secret=${secret}&issuer=Nicotes&algorithm=SHA1&digits=6&period=30`);
    const enabled = await api.call<RecoveryCodes>('POST', '/api/security/totp/enable', { code: codeAt(secret) });
    expect(enabled.status).toBe(200);
    api.logout();
    return { api, secret, codes: enabled.body.codes };
  }

  const login = async (api: ReturnType<typeof setup>) =>
    (await api.call<TwoFactorChallenge>('POST', '/api/auth/login', { username: 'nico', password: 'secret-pass' })).body;

  it('asks for a code after the password, then signs in', async () => {
    const { api, secret, codes } = await withTwoFactor();
    expect(codes).toHaveLength(10);
    expect(codes[0]).toMatch(/^[a-z2-9]{5}-[a-z2-9]{5}$/);

    const challenge = await login(api);
    expect(challenge).toEqual({ twoFactor: true, ticket: expect.any(String), passkey: false });
    expect((await api.call('GET', '/api/notebooks')).status).toBe(401);

    const wrong = await api.call('POST', '/api/auth/login/code', { ticket: challenge.ticket, code: '000000' });
    expect(wrong.status).toBe(401);
    // The code the setup was confirmed with is used up; the next one works.
    expect((await api.call('POST', '/api/auth/login/code', { ticket: challenge.ticket, code: codeAt(secret) })).status).toBe(401);
    const ok = await api.call<User>('POST', '/api/auth/login/code', { ticket: challenge.ticket, code: codeAt(secret, 1) });
    expect(ok.status).toBe(200);
    expect(ok.body.username).toBe('nico');
    expect((await api.call('GET', '/api/notebooks')).status).toBe(200);

    // A ticket is single-use, and so is a code.
    expect((await api.call('POST', '/api/auth/login/code', { ticket: challenge.ticket, code: codeAt(secret, 1) })).status).toBe(401);
    api.logout();
    const again = await login(api);
    expect((await api.call('POST', '/api/auth/login/code', { ticket: again.ticket, code: codeAt(secret, 1) })).status).toBe(401);
  });

  it('accepts each recovery code once', async () => {
    const { api, codes } = await withTwoFactor();
    const first = await login(api);
    expect((await api.call('POST', '/api/auth/login/code', { ticket: first.ticket, code: codes[3]!.toUpperCase() })).status).toBe(200);
    expect((await api.call<SecurityStatus>('GET', '/api/security')).body.recoveryCodesLeft).toBe(9);
    api.logout();
    const second = await login(api);
    const reused = await api.call<{ error: string }>('POST', '/api/auth/login/code', { ticket: second.ticket, code: codes[3]! });
    expect(reused).toEqual({ status: 401, body: { error: 'That recovery code is wrong or used up' } });
  });

  it('limits wrong codes per ticket and per account', async () => {
    const { api, codes } = await withTwoFactor();
    const first = await login(api);
    for (let i = 0; i < 5; i++) await api.call('POST', '/api/auth/login/code', { ticket: first.ticket, code: '000000' });
    // The ticket is gone after five wrong codes.
    expect((await api.call('POST', '/api/auth/login/code', { ticket: first.ticket, code: '000000' })).status).toBe(401);
    const second = await login(api);
    for (let i = 0; i < 5; i++) await api.call('POST', '/api/auth/login/code', { ticket: second.ticket, code: '000000' });
    const third = await login(api);
    expect((await api.call('POST', '/api/auth/login/code', { ticket: third.ticket, code: '000000' })).status).toBe(429);
    // Recovery codes still work for the owner.
    expect((await api.call('POST', '/api/auth/login/code', { ticket: third.ticket, code: codes[0]! })).status).toBe(200);
  });

  it('lets tickets expire after five minutes', async () => {
    const { api, secret } = await withTwoFactor();
    const challenge = await login(api);
    vi.setSystemTime(Date.now() + 6 * 60 * 1000);
    const late = await api.call<{ error: string }>('POST', '/api/auth/login/code', { ticket: challenge.ticket, code: codeAt(secret) });
    expect(late.status).toBe(401);
    expect(late.body.error).toMatch(/took too long/);
  });

  it('needs the password again to change anything', async () => {
    const api = setup();
    await api.call('POST', '/api/auth/setup', { username: 'nico', password: 'secret-pass' });
    expect((await api.call<SecurityStatus>('GET', '/api/security')).body).toEqual({
      confirmed: false,
      totp: { enabled: false, enabledAt: null },
      recoveryCodesLeft: 0,
      passkeys: [],
    });
    expect((await api.call('POST', '/api/security/totp')).status).toBe(403);
    expect((await api.call('POST', '/api/security/confirm', { password: 'wrong-pass' })).status).toBe(401);
    expect((await api.call('POST', '/api/security/confirm', { password: 'secret-pass' })).status).toBe(204);
    expect((await api.call<SecurityStatus>('GET', '/api/security')).body.confirmed).toBe(true);
    expect((await api.call('POST', '/api/security/totp')).status).toBe(200);
    // Ten minutes later, it is locked again.
    vi.setSystemTime(Date.now() + 11 * 60 * 1000);
    expect((await api.call('POST', '/api/security/totp')).status).toBe(403);
  });

  it('turns off, and new recovery codes replace the old ones', async () => {
    const { api, secret, codes } = await withTwoFactor();
    const challenge = await login(api);
    await api.call('POST', '/api/auth/login/code', { ticket: challenge.ticket, code: codeAt(secret, 1) });
    await api.call('POST', '/api/security/confirm', { password: 'secret-pass' });
    const fresh = (await api.call<RecoveryCodes>('POST', '/api/security/recovery-codes')).body.codes;
    expect(fresh).toHaveLength(10);
    expect(fresh).not.toContain(codes[0]);

    expect((await api.call('DELETE', '/api/security/totp')).status).toBe(204);
    expect((await api.call<SecurityStatus>('GET', '/api/security')).body.totp.enabled).toBe(false);
    api.logout();
    const plain = await api.call<LoginResult>('POST', '/api/auth/login', { username: 'nico', password: 'secret-pass' });
    expect(plain.body).toEqual({ id: expect.any(String), username: 'nico' });
  });

  it('is out of reach for API tokens', async () => {
    const api = setup();
    await api.call('POST', '/api/auth/setup', { username: 'nico', password: 'secret-pass' });
    const { token } = (await api.call<{ token: string }>('POST', '/api/tokens', { name: 'Script', scope: 'write' })).body;
    const res = await api.request('/api/security', { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(403);
  });
});
