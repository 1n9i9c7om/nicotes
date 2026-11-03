import { expect, test } from '@playwright/test';
import { createNotebook, uniq } from './fixtures';

test('draws on a canvas page and keeps the drawing', async ({ page }) => {
  const notebook = await createNotebook(page, uniq('Sketches'));
  await page.goto(`/n/${notebook.id}`);
  const row = page.locator('.notebook-row', { hasText: notebook.title });
  await row.hover();
  await row.locator('.tree-actions button').last().click();
  await page.getByRole('menuitem', { name: 'New canvas' }).click();

  const host = page.locator('.canvas-host');
  await expect(host.locator('canvas').first()).toBeVisible({ timeout: 20_000 });
  await page.getByLabel('Page title').fill('Floor plan');
  const box = (await host.boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await host.click({ position: { x: 20, y: box.height - 20 } });
  await page.keyboard.press('r');
  await page.mouse.move(x - 150, y - 80);
  await page.mouse.down();
  await page.mouse.move(x, y + 40, { steps: 6 });
  await page.mouse.up();
  await page.keyboard.press('t');
  await page.mouse.click(x + 60, y - 40);
  await page.keyboard.type('Sofa by the window');
  await page.keyboard.press('Escape');

  // The text is written into the page, where search finds it.
  const id = page.url().split('/p/')[1]!;
  await expect
    .poll(async () => ((await (await page.request.get(`/api/pages/${id}`)).json()) as { content: string }).content, { timeout: 10_000 })
    .toContain('Sofa by the window ^');
  const pages = (await (await page.request.get('/api/pages')).json()) as { id: string; canvas: boolean }[];
  expect(pages.find((p) => p.id === id)?.canvas).toBe(true);

  await page.reload();
  await expect(host.locator('canvas').first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByLabel('Page title')).toHaveValue('Floor plan');
  // Text pages' tools are not shown for drawings.
  await expect(page.getByRole('group', { name: 'Editor mode' })).toHaveCount(0);
});

test('the notebook page makes a canvas too', async ({ page }) => {
  const notebook = await createNotebook(page, uniq('Sketches'));
  await page.goto(`/n/${notebook.id}`);
  await page.getByRole('button', { name: 'New canvas' }).click();
  await expect(page).toHaveURL(/\/p\//);
  await expect(page.locator('.canvas-host canvas').first()).toBeVisible({ timeout: 20_000 });
});
