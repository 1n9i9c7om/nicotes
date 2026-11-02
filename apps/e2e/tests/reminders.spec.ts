import { expect, test } from '@playwright/test';
import { createNotebook, createPage, uniq } from './fixtures';

test('shows reminder times on tasks and saves the morning summary', async ({ page }) => {
  const notebook = await createNotebook(page, uniq('Errands'));
  const task = uniq('Call the dentist');
  await createPage(page, { notebookId: notebook.id, title: 'Calls', content: `- [ ] ${task} ⏰ 09:30 📅 2026-11-04` });

  await page.goto('/tasks');
  const row = page.locator('.task-row', { hasText: task });
  await expect(row.locator('.task-remind')).toHaveText('09:30');
  await expect(row.locator('.task-text')).not.toContainText('⏰');

  await page.goto('/settings#reminders');
  const card = page.locator('#reminders');
  await card.getByLabel('Summary time').fill('07:15');
  await card.getByRole('checkbox').click();
  await expect(card.getByRole('checkbox')).toBeChecked();
  await page.reload();
  await expect(card.getByRole('checkbox')).toBeChecked();
  await expect(card.getByLabel('Summary time')).toHaveValue('07:15');
  // The browser's time zone was saved along with it.
  await expect(card.getByText(/Times are in [A-Za-z_]+\/[A-Za-z_]+\./)).toBeVisible();

  // Without a device or chat there is nothing to test yet.
  await card.getByRole('button', { name: 'Send a test reminder' }).click();
  await expect(card.getByText('Turn on a device or connect Telegram first')).toBeVisible();

  await card.getByRole('checkbox').click();
  await expect(card.getByRole('checkbox')).not.toBeChecked();
});
