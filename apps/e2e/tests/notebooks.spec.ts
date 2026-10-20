import { expect, test } from '@playwright/test';
import { createNotebook, createPage, getPage, rowMenu, sidebar, treeRow, uniq, visualEditor } from './fixtures';

test('creates a notebook with nested pages', async ({ page }) => {
  const notebook = uniq('Notebook');
  const parent = uniq('Parent');
  const child = uniq('Child');

  await page.goto('/');
  await sidebar(page).getByRole('button', { name: 'New notebook' }).click();
  const dialog = page.getByRole('dialog', { name: 'New notebook' });
  await dialog.getByLabel('Name').fill(notebook);
  await dialog.getByRole('button', { name: 'Create' }).click();
  await expect(page).toHaveURL(/\/n\//);
  await expect(page.getByRole('heading', { name: notebook, level: 1 })).toBeVisible();

  // A new page opens with its title focused.
  const row = treeRow(page, notebook);
  await row.hover();
  await row.getByRole('button', { name: 'New page' }).click();
  await expect(page).toHaveURL(/\/p\//);
  await expect(page.getByLabel('Page title')).toBeFocused();
  await page.keyboard.type(parent);
  await expect(treeRow(page, parent)).toBeVisible();

  const parentRow = treeRow(page, parent);
  await parentRow.hover();
  await parentRow.getByRole('button', { name: 'New subpage' }).click();
  await expect(page.getByLabel('Page title')).toBeFocused();
  await page.keyboard.type(child);
  // Enter moves on to the text.
  await page.keyboard.press('Enter');
  await expect(visualEditor(page)).toBeFocused();
  await page.keyboard.type('Nested content');

  await expect(treeRow(page, child)).toBeVisible();
  const crumbs = page.getByRole('navigation', { name: 'Breadcrumb' });
  await expect(crumbs.getByRole('link', { name: notebook })).toBeVisible();
  await expect(crumbs.getByRole('link', { name: parent })).toBeVisible();

  // Everything is still there after a reload.
  await page.reload();
  await expect(page.getByLabel('Page title')).toHaveValue(child);
  await expect(visualEditor(page)).toContainText('Nested content');
  await expect(treeRow(page, parent)).toBeVisible();
});

test('renaming a page rewrites [[links]] to it in other pages', async ({ page }) => {
  const nb = await createNotebook(page, uniq('Rename NB'));
  const oldTitle = uniq('Old name');
  const newTitle = uniq('New name');
  await createPage(page, { notebookId: nb.id, title: oldTitle, content: 'Target page' });
  const linker = await createPage(page, { notebookId: nb.id, title: uniq('Linker'), content: `See [[${oldTitle}]] here.` });

  await page.goto(`/p/${linker.id}`);
  await expect(visualEditor(page).getByText(oldTitle)).toBeVisible();

  await rowMenu(page, oldTitle, 'Rename');
  const input = sidebar(page).getByRole('textbox');
  await input.fill(newTitle);
  await input.press('Enter');
  await expect(treeRow(page, newTitle)).toBeVisible();

  await expect.poll(async () => (await getPage(page, linker.id)).content).toBe(`See [[${newTitle}]] here.`);
  // The open page picks up the rewritten text without a reload.
  await expect(visualEditor(page).getByText(newTitle)).toBeVisible();
  await expect(visualEditor(page).getByText(oldTitle)).toHaveCount(0);
});

test('moves a page to another notebook with "Move to…"', async ({ page }) => {
  const from = await createNotebook(page, uniq('From NB'));
  const to = await createNotebook(page, uniq('To NB'));
  const title = uniq('Traveller');
  const moved = await createPage(page, { notebookId: from.id, title, content: 'On the move' });

  await page.goto(`/p/${moved.id}`);
  await rowMenu(page, title, 'Move to…');
  const dialog = page.getByRole('dialog', { name: `Move “${title}” to…` });
  await dialog.getByPlaceholder('Filter notebooks and pages').fill(to.title);
  await dialog.getByRole('button', { name: to.title }).click();
  await expect(dialog).toBeHidden();

  await expect(page.getByRole('navigation', { name: 'Breadcrumb' }).getByRole('link', { name: to.title })).toBeVisible();
  await expect.poll(async () => (await getPage(page, moved.id)).notebookId).toBe(to.id);
  // The sidebar lists it under its new notebook.
  const group = treeRow(page, to.title).locator('xpath=..');
  await expect(group.getByRole('link', { name: title })).toBeVisible();
});

test('deletes a page with its subpage and restores it from the trash', async ({ page }) => {
  const nb = await createNotebook(page, uniq('Trash NB'));
  const title = uniq('Doomed');
  const doomed = await createPage(page, { notebookId: nb.id, title, content: 'Soon gone' });
  await createPage(page, { notebookId: nb.id, parentId: doomed.id, title: uniq('Doomed child') });

  await page.goto(`/p/${doomed.id}`);
  await rowMenu(page, title, 'Delete');
  const confirm = page.getByRole('dialog', { name: 'Delete page?' });
  await expect(confirm).toContainText('and its subpages');
  await confirm.getByRole('button', { name: 'Delete' }).click();

  // The open page was deleted, so the editor leaves it.
  await expect(page).toHaveURL(new RegExp(`/n/${nb.id}$`));
  await expect(treeRow(page, title)).toHaveCount(0);

  await sidebar(page).getByRole('link', { name: 'Trash', exact: true }).click();
  const item = page.getByRole('listitem').filter({ hasText: title });
  await expect(item).toContainText('1 subpage');
  await item.getByRole('button', { name: 'Restore' }).click();
  await expect(item).toHaveCount(0);

  await expect(treeRow(page, title)).toBeVisible();
  await treeRow(page, title).getByRole('link').click();
  await expect(visualEditor(page)).toContainText('Soon gone');
});
