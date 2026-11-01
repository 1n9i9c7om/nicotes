import { expect, test } from '@playwright/test';
import { createNotebook, createPage, uniq } from './fixtures';

test('subscribes to tasks with due dates as a calendar, and stops sharing it', async ({ page, playwright }) => {
  const nb = await createNotebook(page, uniq('Calendar NB'));
  const task = uniq('Call the plumber');
  await createPage(page, { notebookId: nb.id, title: uniq('Chores'), content: `- [ ] ${task} 📅 2030-01-15` });

  await page.goto('/settings#calendar');
  const section = page.locator('#calendar');
  await section.getByRole('button', { name: 'Create address' }).click();
  const field = section.getByLabel('Calendar address');
  await expect(field).toHaveValue(/\/api\/calendar\/nct_[\w-]+\.ics$/);
  const url = await field.inputValue();

  // A calendar app fetches it without signing in.
  const calendarApp = await playwright.request.newContext();
  const feed = await calendarApp.get(url);
  expect(feed.status()).toBe(200);
  const ics = await feed.text();
  expect(ics).toContain('BEGIN:VCALENDAR');
  expect(ics).toContain(`SUMMARY:${task}`);
  expect(ics).toContain('DTSTART;VALUE=DATE:20300115');

  await section.getByRole('button', { name: 'Stop sharing' }).click();
  await expect(section.getByRole('button', { name: 'Create address' })).toBeVisible();
  expect((await calendarApp.get(url)).status()).toBe(404);
  await calendarApp.dispose();
});
