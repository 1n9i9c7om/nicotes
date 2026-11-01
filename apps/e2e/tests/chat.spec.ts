import { expect, test } from '@playwright/test';
import { sidebar } from './fixtures';

test('the chat is right below search, and old Ask links lead to it', async ({ page }) => {
  await page.goto('/');
  const entries = sidebar(page).locator('.sidebar-scroll > .nav-item');
  await expect(entries.nth(0)).toContainText('Search');
  await expect(entries.nth(1)).toHaveText('Chat');

  await page.goto('/ask?q=hello');
  await expect(page).toHaveURL(/\/chat/);
  await expect(page.getByRole('heading', { name: 'Chat' })).toBeVisible();
  // The test server has no AI service, so the chat says what it needs.
  await expect(page.getByRole('alert')).toContainText('The chat needs an OpenRouter API key');
  await expect(page.getByRole('button', { name: 'Send' })).toBeDisabled();
});
