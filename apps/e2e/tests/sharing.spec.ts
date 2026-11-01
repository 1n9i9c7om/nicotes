import { expect, test } from '@playwright/test';
import { createNotebook, createPage, uniq } from './fixtures';

test('shares a page with its subpages as a read-only link, then turns it off', async ({ page, browser }) => {
  const notebook = await createNotebook(page, uniq('Trips'));
  const trip = await createPage(page, {
    notebookId: notebook.id,
    title: uniq('Lisbon'),
    content: 'Then the train to [[Porto]].\n\n- [ ] Sun cream',
  });
  await createPage(page, { notebookId: notebook.id, parentId: trip.id, title: 'Porto', content: 'Cellars in Gaia.' });

  await page.goto(`/p/${trip.id}`);
  await page.getByRole('button', { name: 'Page actions' }).click();
  await page.getByRole('menuitem', { name: 'Share…' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel('Include its subpages')).toBeChecked();
  await dialog.getByRole('button', { name: 'Create link' }).click();
  const link = await dialog.getByLabel('Shared link').inputValue();
  expect(link).toMatch(/\/s\/[A-Za-z0-9_-]{24}$/);
  await dialog.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByRole('button', { name: 'Shared' })).toBeVisible();

  // Someone without an account opens it.
  const visitor = await browser.newContext({ storageState: { cookies: [], origins: [] }, serviceWorkers: 'block' });
  const view = await visitor.newPage();
  await view.goto(link);
  await expect(view.getByRole('heading', { name: trip.title })).toBeVisible();
  await expect(view.getByText('Read-only')).toBeVisible();
  // Nothing can be edited or ticked off.
  await expect(view.locator('.ProseMirror')).toHaveAttribute('contenteditable', 'false');
  await view.locator('.prose .wikilink', { hasText: 'Porto' }).click();
  await expect(view.getByRole('heading', { name: 'Porto' })).toBeVisible();
  await expect(view.getByText('Cellars in Gaia.')).toBeVisible();

  // Turned off, the link shows nothing.
  await page.goto('/settings#shared-links');
  const row = page.locator('#shared-links .share-link', { hasText: trip.title });
  await expect(row).toContainText('viewed once');
  await row.getByRole('button', { name: 'Turn off' }).click();
  await row.getByRole('button', { name: 'Turn off now' }).click();
  await expect(row).toHaveCount(0);
  await view.reload();
  await expect(view.getByRole('heading', { name: "This link doesn't work" })).toBeVisible();
  await visitor.close();
});
