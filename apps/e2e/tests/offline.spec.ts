import { expect, test, type Page } from '@playwright/test';
import { createNotebook, createPage, getPage, sidebar, uniq, visualEditor } from './fixtures';

// Service workers are blocked in the tests, so these stay within one page load (the offline
// reload with the installed app's service worker is checked by hand; see docs/DEVELOPMENT.md).

const saveStatus = (page: Page) => page.locator('.page-bar').getByRole('status');

/** Pages on this device, once the first copy is done. */
const devicePages = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        const open = indexedDB.open('nicotes-offline');
        open.onsuccess = () => {
          const count = open.result.transaction('pages').objectStore('pages').count();
          count.onsuccess = () => resolve(count.result);
        };
        open.onerror = () => resolve(0);
      }),
  );

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('nicotes.offline', 'on'));
});

test('pages open and can be edited offline; edits are combined with changes made meanwhile', async ({ page, context }) => {
  const nb = await createNotebook(page, uniq('Offline NB'));
  const first = await createPage(page, { notebookId: nb.id, title: uniq('Groceries'), content: 'Milk' });
  const trip = await createPage(page, { notebookId: nb.id, title: uniq('Trip'), content: 'Day 1: Hamburg\n\nDay 2: Lübeck\n\nDay 3: Kiel' });

  await page.goto(`/p/${first.id}`);
  await expect.poll(() => devicePages(page)).toBeGreaterThanOrEqual(2);

  await context.setOffline(true);
  await sidebar(page).getByRole('link', { name: trip.title }).click();
  await expect(page.getByText('Offline: showing the notes saved on this device')).toBeVisible();
  await visualEditor(page).getByText('Day 1: Hamburg').click();
  await page.keyboard.press('End');
  await page.keyboard.type(' and Altona');
  await expect(saveStatus(page)).toHaveText('Saved on this device');

  // Someone else changes another line meanwhile (API requests ignore the offline browser).
  const current = await getPage(page, trip.id);
  await page.request.patch(`/api/pages/${trip.id}`, { data: { content: current.content.replace('Kiel', 'Kiel and Laboe'), baseVersion: current.version } });

  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect.poll(async () => (await getPage(page, trip.id)).content).toBe('Day 1: Hamburg and Altona\n\nDay 2: Lübeck\n\nDay 3: Kiel and Laboe');
  await expect(visualEditor(page)).toContainText('Kiel and Laboe');
  await expect(saveStatus(page)).toHaveText('Saved');
});

test('an offline edit of lines changed elsewhere is kept as a copy', async ({ page, context }) => {
  const nb = await createNotebook(page, uniq('Offline NB'));
  const plan = await createPage(page, { notebookId: nb.id, title: uniq('Plan'), content: 'Meet at 10' });
  const other = await createPage(page, { notebookId: nb.id, title: uniq('Other'), content: '' });

  await page.goto(`/p/${plan.id}`);
  await expect.poll(() => devicePages(page)).toBeGreaterThanOrEqual(2);
  await context.setOffline(true);
  await visualEditor(page).getByText('Meet at 10').click();
  await page.keyboard.press('End');
  await page.keyboard.type(' sharp');
  await expect(saveStatus(page)).toHaveText('Saved on this device');
  // Leave the page, so the queue (not the editor) sends the edit.
  await sidebar(page).getByRole('link', { name: other.title }).click();
  await expect(page.getByLabel('Page title')).toHaveValue(other.title);

  const current = await getPage(page, plan.id);
  await page.request.patch(`/api/pages/${plan.id}`, { data: { content: 'Meet at 11', baseVersion: current.version } });

  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(page.getByRole('alert')).toContainText(`Your offline edits of “${plan.title}” clashed`);
  expect((await getPage(page, plan.id)).content).toBe('Meet at 11');
  const pages = (await (await page.request.get('/api/pages')).json()) as { id: string; title: string; parentId: string | null }[];
  const copy = pages.find((p) => p.title === `${plan.title} (offline copy)`);
  expect(copy?.parentId).toBe(plan.id);
  expect((await getPage(page, copy!.id)).content).toBe('Meet at 10 sharp');
});
