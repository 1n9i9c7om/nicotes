import { expect, test } from '@playwright/test';
import { createNotebook, createPage, sidebar, uniq } from './fixtures';

test('prints a page on its own, named after it', async ({ page }) => {
  const nb = await createNotebook(page, uniq('Print NB'));
  const doc = await createPage(page, { notebookId: nb.id, title: uniq('Bread'), content: '## Steps\n\n1. Mix\n2. Bake' });
  await page.goto(`/p/${doc.id}`);
  await page.evaluate(() => {
    (window as unknown as { printed: string[] }).printed = [];
    window.print = () => (window as unknown as { printed: string[] }).printed.push(document.title);
  });

  await page.getByRole('button', { name: 'Page actions' }).click();
  await page.getByRole('menuitem', { name: 'Print or save as PDF' }).click();
  expect(await page.evaluate(() => (window as unknown as { printed: string[] }).printed)).toEqual([doc.title]);
  // Ctrl+P goes the same way.
  await page.keyboard.press('Control+p');
  expect(await page.evaluate(() => (window as unknown as { printed: string[] }).printed)).toHaveLength(2);

  await page.emulateMedia({ media: 'print' });
  await expect(sidebar(page)).toBeHidden();
  await expect(page.getByRole('heading', { name: doc.title, level: 1 })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Steps' })).toBeVisible();
  await expect(page.getByRole('toolbar', { name: 'Formatting' })).toBeHidden();
});
