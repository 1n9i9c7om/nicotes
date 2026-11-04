import { expect, test } from '@playwright/test';
import { createNotebook, createPage, uniq } from './fixtures';

test('shows reminder times on tasks and saves the daily summaries', async ({ page }) => {
  const notebook = await createNotebook(page, uniq('Errands'));
  const task = uniq('Call the dentist');
  await createPage(page, { notebookId: notebook.id, title: 'Calls', content: `- [ ] ${task} ⏰ 09:30 📅 2099-11-04` });

  await page.goto('/tasks');
  const row = page.locator('.task-row', { hasText: task });
  await expect(row.locator('.task-remind')).toHaveText('09:30');
  await expect(row.locator('.task-text')).not.toContainText('⏰');

  await page.goto('/settings#reminders');
  const card = page.locator('#reminders');
  // A morning and an evening summary.
  await card.getByRole('button', { name: 'Get a daily summary' }).click();
  await card.getByLabel('Summary 1 time').fill('07:15');
  await card.getByLabel('Summary 1 time').blur();
  await card.getByRole('button', { name: 'Add a summary' }).click();
  await expect(card.getByLabel('Summary 2 time')).toHaveValue('20:00');
  await page.reload();
  await expect(card.getByLabel('Summary 1 time')).toHaveValue('07:15');
  await expect(card.getByLabel('Summary 2 time')).toHaveValue('20:00');
  // The browser's time zone was saved along with it.
  await expect(card.getByText(/Times are in [A-Za-z_]+\/[A-Za-z_]+\./)).toBeVisible();

  // Without a device or chat there is nothing to test yet.
  await card.getByRole('button', { name: 'Send a test reminder' }).click();
  await expect(card.getByText('Turn on a device or connect Telegram first')).toBeVisible();

  await card.getByRole('button', { name: 'Remove summary 2' }).click();
  await card.getByRole('button', { name: 'Remove summary 1' }).click();
  await expect(card.getByRole('button', { name: 'Get a daily summary' })).toBeVisible();
  await page.reload();
  await expect(card.getByLabel('Summary 1 time')).toHaveCount(0);
});
