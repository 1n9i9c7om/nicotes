import { expect, test } from '@playwright/test';
import { createNotebook, createPage, sidebar, uniq, visualEditor } from './fixtures';

test('the graph renders and finds a page', async ({ page }) => {
  const nb = await createNotebook(page, uniq('Graph NB'));
  const hub = await createPage(page, { notebookId: nb.id, title: uniq('Hub'), content: 'Center' });
  await createPage(page, { notebookId: nb.id, title: uniq('Spoke'), content: `Points to [[${hub.title}]]` });

  await page.goto('/');
  await sidebar(page).getByRole('link', { name: 'Graph', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Graph', level: 1 })).toBeVisible();
  await expect(page.locator('.graph-stage canvas').first()).toBeVisible();

  const find = page.getByPlaceholder('Find a node…');
  await find.fill(hub.title);
  await find.press('Enter');
  // The card for the found node: its notebook and the one link from the other page.
  await expect(page.getByText(`${nb.title} · 1 connection`, { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Open' }).click();
  await expect(page).toHaveURL(new RegExp(`/p/${hub.id}$`));
});

test('Ctrl+K finds a page by its content', async ({ page }) => {
  const nb = await createNotebook(page, uniq('Search NB'));
  const word = `quokka${Math.random().toString(36).slice(2, 8)}`;
  const doc = await createPage(page, { notebookId: nb.id, title: uniq('Wildlife'), content: `Saw a ${word} on Rottnest.` });

  await page.goto('/');
  await expect(sidebar(page)).toBeVisible();
  await page.keyboard.press('Control+K');
  const palette = page.getByRole('dialog', { name: 'Search' });
  await palette.getByPlaceholder('Search pages, #tags and content…').fill(word);
  const hit = palette.getByRole('option', { name: new RegExp(doc.title) });
  await expect(hit).toBeVisible();
  await expect(hit.locator('mark')).toHaveText(word);
  await page.keyboard.press('Enter');

  await expect(page).toHaveURL(new RegExp(`/p/${doc.id}$`));
  await expect(visualEditor(page)).toContainText(word);
});
