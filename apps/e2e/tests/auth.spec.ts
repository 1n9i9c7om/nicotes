import { expect, test } from '@playwright/test';
import { ADMIN, sidebar } from './fixtures';

const signedOut = { cookies: [], origins: [] };

test.describe('first run', () => {
  // A second server with an empty data dir and no NICOTES_ADMIN_USER shows the setup screen.
  test.use({ baseURL: `http://127.0.0.1:${process.env.E2E_SETUP_PORT}`, storageState: signedOut });

  test('creates the account, then signs out and back in', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Welcome to Nicotes' })).toBeVisible();
    await page.getByLabel('Username').fill('Owner');
    await page.getByLabel('Password').fill('first-run-password');
    await page.getByRole('button', { name: 'Create account' }).click();

    // Usernames are stored lower-case.
    await expect(page.getByRole('heading', { name: 'Hello, owner' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Start with a notebook' })).toBeVisible();

    await sidebar(page).getByRole('button', { name: 'Sign out' }).click();
    // Setup is done: the login screen replaces it for good.
    await expect(page.getByRole('heading', { name: 'Sign in to Nicotes' })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Sign in to Nicotes' })).toBeVisible();

    await page.getByLabel('Username').fill('owner');
    await page.getByLabel('Password').fill('first-run-password');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('heading', { name: 'Hello, owner' })).toBeVisible();
  });
});

test.describe('login', () => {
  test.use({ storageState: signedOut });

  test('rejects a wrong password, signs in, keeps the session, signs out', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Sign in to Nicotes' })).toBeVisible();

    await page.getByLabel('Username').fill(ADMIN.username);
    await page.getByLabel('Password').fill('not-the-password');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByText('Wrong username or password')).toBeVisible();

    await page.getByLabel('Password').fill(ADMIN.password);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('heading', { name: `Hello, ${ADMIN.username}` })).toBeVisible();

    await page.reload();
    await expect(page.getByRole('heading', { name: `Hello, ${ADMIN.username}` })).toBeVisible();

    await sidebar(page).getByRole('button', { name: 'Sign out' }).click();
    await expect(page.getByRole('heading', { name: 'Sign in to Nicotes' })).toBeVisible();
    // The session is gone on the server too, not just in the UI.
    expect((await page.request.get('/api/notebooks')).status()).toBe(401);
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Sign in to Nicotes' })).toBeVisible();
  });
});
