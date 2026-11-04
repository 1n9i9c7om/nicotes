import { expect, test, type Locator, type Page } from '@playwright/test';
import { EMPTY_CANVAS } from '@nicotes/shared';
import { caretToEnd, createNotebook, createPage, getPage, rowMenu, sidebar, uniq, visualEditor } from './fixtures';

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

/** Draws a rectangle in the canvas on screen. */
async function drawBox(page: Page, host: Locator) {
  await expect(host.locator('canvas').first()).toBeVisible({ timeout: 20_000 });
  const box = (await host.boundingBox())!;
  const [x, y] = [box.x + box.width / 2, box.y + box.height / 2];
  await host.click({ position: { x: 20, y: box.height - 20 } });
  await page.keyboard.press('r');
  await page.mouse.move(x - 120, y - 60);
  await page.mouse.down();
  await page.mouse.move(x, y + 40, { steps: 6 });
  await page.mouse.up();
}

test('a drawing in a page: added at the cursor, edited over the page, shown as a picture', async ({ page }) => {
  const notebook = await createNotebook(page, uniq('Sketches'));
  const doc = await createPage(page, { notebookId: notebook.id, title: uniq('Floor plan'), content: 'Before the drawing' });
  await page.goto(`/p/${doc.id}`);
  await visualEditor(page).getByText('Before the drawing').click();
  await caretToEnd(page);
  await page.getByRole('button', { name: 'Add a drawing' }).click();

  // It opens right away; Done straight after the last stroke keeps it.
  const dialog = page.getByRole('dialog', { name: 'Drawing' });
  await drawBox(page, dialog.locator('.canvas-host'));
  await dialog.getByRole('button', { name: 'Done' }).click();
  await expect(dialog).toHaveCount(0);

  const picture = visualEditor(page).getByRole('button', { name: 'Edit this drawing' });
  await expect(picture.locator('svg rect, svg path').first()).toBeAttached();
  await expect.poll(async () => (await getPage(page, doc.id)).content).toMatch(/^Before the drawing\n\n!\[\[Drawing \d+\]\]$/);
  const pages = (await (await page.request.get('/api/pages')).json()) as { id: string; parentId: string | null; canvas: boolean }[];
  const drawing = pages.find((p) => p.parentId === doc.id);
  expect(drawing?.canvas).toBe(true);

  // The text goes on below it.
  await caretToEnd(page);
  await page.keyboard.type('After the drawing');
  await expect.poll(async () => (await getPage(page, doc.id)).content).toMatch(/\]\]\n\nAfter the drawing$/);

  // Back after a reload, and clicking it opens it again; the page shows what changed.
  await page.reload();
  const shapes = () => picture.locator('svg g').count();
  await expect(picture.locator('svg')).toBeAttached({ timeout: 20_000 });
  const before = await shapes();
  await picture.click();
  await drawBox(page, dialog.locator('.canvas-host'));
  await dialog.getByRole('button', { name: 'Done' }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(shapes).toBeGreaterThan(before);
  expect((await getPage(page, drawing!.id)).title).toMatch(/^Drawing \d+$/);
});

test('leaving a canvas right after a stroke keeps it, and subpages can be canvases too', async ({ page }) => {
  const notebook = await createNotebook(page, uniq('Sketches'));
  const parent = await createPage(page, { notebookId: notebook.id, title: uniq('Rooms'), content: '' });
  await page.goto(`/p/${parent.id}`);
  await rowMenu(page, parent.title, 'New canvas');
  await expect(page).not.toHaveURL(new RegExp(`/p/${parent.id}$`));
  const id = page.url().split('/p/')[1]!;
  await drawBox(page, page.locator('.canvas-host'));
  await sidebar(page).getByRole('link', { name: parent.title }).click();
  await expect(page.getByLabel('Page title')).toHaveValue(parent.title);
  // A rectangle is in the scene, which only the save can have put there.
  await expect.poll(async () => (await getPage(page, id)).content.length).toBeGreaterThan(EMPTY_CANVAS.length + 100);
});
