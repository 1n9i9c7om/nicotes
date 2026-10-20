import { expect, test } from '@playwright/test';
import { createNotebook, createPage, getPage, sidebar, uniq, visualEditor, waitForSave } from './fixtures';

// Runs in the "mobile" project (Pixel 7 viewport, touch).
test('opens a page from the sidebar drawer and edits it', async ({ page }) => {
  const nb = await createNotebook(page, uniq('Phone NB'));
  const doc = await createPage(page, { notebookId: nb.id, title: uniq('On the go'), content: 'Typed on a phone.' });

  await page.goto('/');
  await expect(sidebar(page)).not.toBeInViewport();
  await page.getByRole('button', { name: 'Open sidebar' }).click();
  await expect(sidebar(page)).toBeInViewport();

  await sidebar(page).getByRole('link', { name: doc.title }).click();
  await expect(page).toHaveURL(new RegExp(`/p/${doc.id}$`));
  // Navigating closes the drawer.
  await expect(sidebar(page)).not.toBeInViewport();
  await expect(page.getByLabel('Page title')).toHaveValue(doc.title);
  await expect(visualEditor(page)).toHaveText('Typed on a phone.');

  await visualEditor(page).tap();
  await page.keyboard.press('End');
  await page.keyboard.type(' And edited.');
  await waitForSave(page);
  expect((await getPage(page, doc.id)).content).toBe('Typed on a phone. And edited.');

  // The drawer also closes with its own button.
  await page.getByRole('button', { name: 'Open sidebar' }).click();
  await sidebar(page).getByRole('button', { name: 'Close sidebar' }).click();
  await expect(sidebar(page)).not.toBeInViewport();
});
