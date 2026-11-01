import { createHmac } from 'node:crypto';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { SECURE, sidebar } from './fixtures';

// A server of its own: these tests turn on two-step sign-in for its only account. WebAuthn
// does not accept IP addresses as the passkey's site, hence localhost.
test.use({ baseURL: `http://localhost:${process.env.E2E_SECURITY_PORT}`, storageState: { cookies: [], origins: [] } });
// One account, one state: the tests take turns.
test.describe.configure({ mode: 'serial' });

/** The authenticator app's side: RFC 6238 with SHA-1, 30-second steps, 6 digits. */
function totp(secret: string, offset = 0): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const char of secret.replace(/\s/g, '')) bits += alphabet.indexOf(char).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000) + offset));
  const mac = createHmac('sha1', key).update(counter).digest();
  const at = mac[19]! & 0xf;
  return String((mac.readUInt32BE(at) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

async function signInWithPassword(page: Page) {
  await page.goto('/');
  await page.getByLabel('Username').fill(SECURE.username);
  await page.getByLabel('Password').fill(SECURE.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}

const home = (page: Page) => expect(page.getByRole('heading', { name: `Hello, ${SECURE.username}` })).toBeVisible();

async function signOut(page: Page) {
  await sidebar(page).getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { name: 'Sign in to Nicotes' })).toBeVisible();
}

async function openSecurity(page: Page) {
  await page.goto('/settings#security');
  return page.locator('#security');
}

/** Changes there ask for the password again first. */
async function confirmPassword(card: Locator) {
  await card.getByLabel('Password').fill(SECURE.password);
  await card.getByRole('button', { name: 'Continue' }).click();
}

test('two-step sign-in with an authenticator app and a recovery code', async ({ page }) => {
  await signInWithPassword(page);
  await home(page);

  const card = await openSecurity(page);
  await card.getByRole('button', { name: 'Set up' }).click();
  await confirmPassword(card);
  await expect(card.getByRole('img', { name: 'QR code for your authenticator app' })).toBeVisible();
  const secret = (await card.locator('.totp-secret').textContent())!;
  await card.getByLabel('Code from the app').fill(totp(secret));
  await card.getByRole('button', { name: 'Turn on' }).click();

  const codes = await card.locator('.recovery-codes li').allTextContents();
  expect(codes).toHaveLength(10);
  await card.getByRole('button', { name: "I've saved them" }).click();
  await expect(card.getByText(/On since .* · 10 recovery codes left/)).toBeVisible();

  // The password alone no longer signs in.
  await signOut(page);
  await signInWithPassword(page);
  await expect(page.getByRole('heading', { name: 'Two-step sign-in' })).toBeVisible();
  await page.getByLabel('Code').fill('000000');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText('Wrong code')).toBeVisible();
  // The code that turned it on is used up; the next one works.
  await page.getByLabel('Code').fill(totp(secret, 1));
  await page.getByRole('button', { name: 'Continue' }).click();
  await home(page);

  await signOut(page);
  await signInWithPassword(page);
  await page.getByRole('button', { name: 'Use a recovery code' }).click();
  await page.getByLabel('Recovery code').fill(codes[0]!);
  await page.getByRole('button', { name: 'Continue' }).click();
  await home(page);

  const again = await openSecurity(page);
  await expect(again.getByText('9 recovery codes left')).toBeVisible();
  await again.getByRole('button', { name: 'Turn off', exact: true }).click();
  await again.getByRole('button', { name: 'Turn off now' }).click();
  await confirmPassword(again);
  await expect(again.getByRole('button', { name: 'Set up' })).toBeVisible();
});

test('passkeys sign in without a password', async ({ page }) => {
  // Chromium's virtual authenticator stands in for a fingerprint reader.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });

  await signInWithPassword(page);
  await home(page);
  const card = await openSecurity(page);
  await card.getByLabel('Passkey name').fill('Test key');
  await card.getByRole('button', { name: 'Add a passkey' }).click();
  await confirmPassword(card);
  const item = card.locator('.trash-item').filter({ hasText: 'Test key' });
  await expect(item).toContainText('never used');

  await signOut(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Sign in with a passkey' }).click();
  await home(page);

  // A new session: the password is asked for again.
  await openSecurity(page);
  await expect(item).toContainText('last used');
  await item.getByRole('button', { name: 'Remove' }).click();
  await item.getByRole('button', { name: 'Remove now' }).click();
  await confirmPassword(card);
  await expect(item).toHaveCount(0);
});
