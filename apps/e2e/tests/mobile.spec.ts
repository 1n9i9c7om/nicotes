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

test('the top bar stays in view while scrolling, with the page bar below it', async ({ page }) => {
  const nb = await createNotebook(page, uniq('Phone NB'));
  const content = Array.from({ length: 80 }, (_, i) => `Paragraph ${i + 1}`).join('\n\n');
  const doc = await createPage(page, { notebookId: nb.id, title: uniq('Long read'), content });
  const menu = page.getByRole('button', { name: 'Open sidebar' });
  const scrollDown = () => page.locator('.main').evaluate((main) => main.scrollTo(0, main.scrollHeight));

  await page.goto(`/p/${doc.id}`);
  await expect(visualEditor(page)).toContainText('Paragraph 80');
  await scrollDown();
  await expect(visualEditor(page).getByText('Paragraph 1', { exact: true })).not.toBeInViewport();
  await expect(menu).toBeInViewport();
  const bar = (await page.locator('.mobile-bar').boundingBox())!;
  const pageBar = (await page.locator('.page-bar').boundingBox())!;
  expect(bar.y).toBe(0);
  expect(pageBar.y).toBeCloseTo(bar.y + bar.height, 0);

  // In the chat too, and the menu still opens the sidebar.
  const history = Array.from({ length: 30 }, (_, i) => ({ id: `m${i}`, role: i % 2 ? 'assistant' : 'user', content: `Message ${i + 1}`, actions: [], createdAt: i }));
  await page.route('**/api/chat', (route) => (route.request().method() === 'GET' ? route.fulfill({ json: history }) : route.continue()));
  await page.goto('/chat');
  await expect(page.getByText('Message 30', { exact: true })).toBeInViewport();
  await expect(page.getByText('Message 1', { exact: true })).not.toBeInViewport();
  await menu.click();
  await expect(sidebar(page)).toBeInViewport();
});
