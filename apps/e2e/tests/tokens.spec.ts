import { expect, test } from '@playwright/test';
import { uniq } from './fixtures';

test('creates an API token, shows it once, and revokes it', async ({ page, playwright, baseURL }) => {
  await page.goto('/settings#tokens');
  const card = page.locator('#tokens');
  const name = uniq('Shortcuts');
  await card.getByLabel('Name').fill(name);
  await card.getByLabel('Access').selectOption('read');
  await card.getByRole('button', { name: 'Create token' }).click();

  const field = card.getByLabel('New API token');
  await expect(field).toHaveValue(/^nct_/);
  const token = await field.inputValue();

  // The token works without the browser's session.
  const script = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { authorization: `Bearer ${token}` } });
  expect((await script.get('/api/notebooks')).status()).toBe(200);
  expect((await script.post('/api/notebooks', { data: { title: 'Nope' } })).status()).toBe(403);

  await card.getByRole('button', { name: 'Done' }).click();
  await expect(field).toHaveCount(0);
  const row = card.locator('.trash-item', { hasText: name });
  await expect(row).toContainText('Read only');
  await expect(row).toContainText(`ends in …${token.slice(-4)}`);

  await row.getByRole('button', { name: 'Revoke' }).click();
  await row.getByRole('button', { name: 'Revoke now' }).click();
  await expect(row).toHaveCount(0);
  expect((await script.get('/api/notebooks')).status()).toBe(401);
  await script.dispose();
});
