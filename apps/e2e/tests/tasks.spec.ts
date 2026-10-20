import { expect, test } from '@playwright/test';
import { createNotebook, createPage, getPage, sidebar, uniq, visualEditor, waitForSave } from './fixtures';

test('a checkbox typed in a page shows under Tasks, and ticking it there updates the page', async ({ page }) => {
  const nb = await createNotebook(page, uniq('Tasks NB'));
  const doc = await createPage(page, { notebookId: nb.id, title: uniq('Chores') });
  const task = uniq('Water the plants');

  await page.goto(`/p/${doc.id}`);
  await visualEditor(page).click();
  await page.keyboard.type(`[ ] ${task}`);
  await waitForSave(page);
  await expect(visualEditor(page).getByRole('checkbox')).not.toBeChecked();
  expect((await getPage(page, doc.id)).content).toBe(`- [ ] ${task}`);

  await sidebar(page).getByRole('link', { name: 'Tasks', exact: true }).click();
  const checkbox = page.getByRole('checkbox', { name: `Complete “${task}”` });
  await expect(checkbox).toBeVisible();
  // Controlled by the task list, so it flips once the optimistic update lands.
  await checkbox.click();
  await expect(page.getByRole('checkbox', { name: `Reopen “${task}”` })).toBeChecked();
  await expect.poll(async () => (await getPage(page, doc.id)).content).toBe(`- [x] ${task}`);

  // Back in the page, the box is ticked.
  await page.getByRole('link', { name: doc.title }).first().click();
  await expect(page).toHaveURL(new RegExp(`/p/${doc.id}$`));
  await expect(visualEditor(page).getByRole('checkbox')).toBeChecked();

  // It moved from Open to Done.
  await sidebar(page).getByRole('link', { name: 'Tasks', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: new RegExp(task) })).toHaveCount(0);
  await page.getByRole('group', { name: 'Show' }).getByRole('button', { name: 'Done' }).click();
  await expect(page.getByRole('checkbox', { name: `Reopen “${task}”` })).toBeChecked();
});
