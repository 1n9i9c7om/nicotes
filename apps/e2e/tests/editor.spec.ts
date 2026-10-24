import { expect, test } from '@playwright/test';
import { createNotebook, createPage, getPage, sourceEditor, uniq, visualEditor, waitForSave } from './fixtures';

test('visual and Markdown edits autosave and survive a reload', async ({ page }) => {
  const nb = await createNotebook(page, uniq('Editor NB'));
  const doc = await createPage(page, { notebookId: nb.id, title: uniq('Editing') });

  await page.goto(`/p/${doc.id}`);
  await visualEditor(page).click();
  // Markdown shortcuts work while typing in the visual editor.
  await page.keyboard.type('## Shopping');
  await page.keyboard.press('Enter');
  await page.keyboard.type('- apples');
  await waitForSave(page);
  await expect(visualEditor(page).getByRole('heading', { name: 'Shopping' })).toBeVisible();
  await expect.poll(async () => (await getPage(page, doc.id)).content).toBe('## Shopping\n\n- apples');

  await page.getByRole('group', { name: 'Editor mode' }).getByRole('button', { name: 'Markdown' }).click();
  const source = sourceEditor(page);
  await expect(source).toContainText('## Shopping');
  await expect(source).toContainText('- apples');
  await source.click();
  await page.keyboard.press('Control+End');
  // Enter continues the list.
  await page.keyboard.press('Enter');
  await page.keyboard.type('pears');
  await waitForSave(page);

  // The editor mode is remembered, and the text came from the server.
  await page.reload();
  await expect(sourceEditor(page)).toContainText('- pears');
  await page.getByRole('group', { name: 'Editor mode' }).getByRole('button', { name: 'Visual' }).click();
  const items = visualEditor(page).getByRole('listitem');
  await expect(items).toHaveText(['apples', 'pears']);
  expect((await getPage(page, doc.id)).content).toBe('## Shopping\n\n- apples\n- pears');
});

test('[[ autocomplete links to an existing page', async ({ page }) => {
  const nb = await createNotebook(page, uniq('Wiki NB'));
  const target = await createPage(page, { notebookId: nb.id, title: uniq('Wiki target'), content: 'Linked to' });
  const doc = await createPage(page, { notebookId: nb.id, title: uniq('Wiki source') });

  await page.goto(`/p/${doc.id}`);
  await visualEditor(page).click();
  await page.keyboard.type('See [[');
  await page.keyboard.type(target.title);
  const option = page.getByRole('option', { name: new RegExp(target.title) });
  await expect(option).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Enter');
  await page.keyboard.type('for more.');
  await waitForSave(page);

  expect((await getPage(page, doc.id)).content).toBe(`See [[${target.title}]] for more.`);

  // The link opens its page.
  await visualEditor(page).getByText(target.title).click();
  await expect(page).toHaveURL(new RegExp(`/p/${target.id}$`));
  await expect(page.getByLabel('Page title')).toHaveValue(target.title);
});

test('restores an earlier version from the history', async ({ page }) => {
  const nb = await createNotebook(page, uniq('History NB'));
  const doc = await createPage(page, { notebookId: nb.id, title: uniq('Versioned'), content: 'The first draft.' });

  await page.goto(`/p/${doc.id}`);
  await expect(visualEditor(page)).toHaveText('The first draft.');
  await visualEditor(page).click();
  await page.keyboard.press('Control+A');
  await page.keyboard.type('A rewrite nobody liked.');
  // The first edit keeps the previous text as a version.
  await waitForSave(page);

  await page.getByRole('button', { name: 'Page actions' }).click();
  await page.getByRole('menuitem', { name: 'Version history' }).click();
  const dialog = page.getByRole('dialog', { name: 'Version history' });
  await expect(dialog.getByRole('button', { name: /Edited/ })).toHaveCount(1);
  await expect(dialog.getByLabel('Changes from the current text to this version')).toContainText('The first draft.');
  await dialog.getByRole('button', { name: 'Restore' }).click();
  await expect(dialog).toBeHidden();

  await expect(visualEditor(page)).toHaveText('The first draft.');
  await expect.poll(async () => (await getPage(page, doc.id)).content).toBe('The first draft.');
  await page.reload();
  await expect(visualEditor(page)).toHaveText('The first draft.');
});

test('dragging the page edge changes and remembers the page width; double-click resets it', async ({ page }) => {
  const nb = await createNotebook(page, uniq('Width NB'));
  const doc = await createPage(page, { notebookId: nb.id, title: uniq('Wide page') });
  await page.goto(`/p/${doc.id}`);

  const body = page.locator('.page-body');
  const width = async () => (await body.boundingBox())!.width;
  const before = await width();
  const handle = (await page.locator('.page-width-handle.right').boundingBox())!;
  const x = handle.x + handle.width / 2;
  const y = handle.y + 200;

  // The body stays centred, so it grows by twice the pointer movement.
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 60, y, { steps: 5 });
  await page.mouse.up();
  expect(await width()).toBeCloseTo(before + 120, -1);

  await page.reload();
  await expect.poll(width).toBeCloseTo(before + 120, -1);

  await page.locator('.page-width-handle.right').dblclick();
  await expect.poll(width).toBe(before);
});
