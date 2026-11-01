import { expect, test } from '@playwright/test';
import { createNotebook, createPage, getPage, uniq } from './fixtures';

/** Opens a page and switches it to the interactive view. */
async function openView(page: import('@playwright/test').Page, id: string) {
  await page.goto(`/p/${id}`);
  await page.getByRole('group', { name: 'Editor mode' }).getByRole('button', { name: 'View' }).click();
}

test('the checklist view ticks, reorders, adds and undoes, editing the page', async ({ page }) => {
  const nb = await createNotebook(page, uniq('Layouts NB'));
  const doc = await createPage(page, {
    notebookId: nb.id,
    title: uniq('Shopping'),
    content: '- [ ] Milk\n- [x] Eggs\n- [ ] Bread',
  });
  const content = async () => (await getPage(page, doc.id)).content;

  await openView(page, doc.id);
  await expect(page.getByRole('combobox', { name: 'Layout' })).toHaveValue('');
  await expect(page.getByText('1 of 3 done')).toBeVisible();

  await page.getByRole('checkbox', { name: 'Milk' }).click();
  await expect.poll(content).toBe('- [x] Milk\n- [x] Eggs\n- [ ] Bread');

  await page.getByRole('button', { name: 'Move “Bread” (arrow keys)' }).press('ArrowUp');
  await expect.poll(content).toBe('- [x] Milk\n- [ ] Bread\n- [x] Eggs');
  // Focus stays on the moved item, so it can keep moving.
  await page.keyboard.press('ArrowUp');
  await expect.poll(content).toBe('- [ ] Bread\n- [x] Milk\n- [x] Eggs');

  await page.getByRole('textbox', { name: 'Add to the list…' }).fill('Butter');
  await page.keyboard.press('Enter');
  await expect.poll(content).toBe('- [ ] Bread\n- [x] Milk\n- [x] Eggs\n- [ ] Butter');

  await page.getByRole('button', { name: 'Undo' }).click();
  await expect.poll(content).toBe('- [ ] Bread\n- [x] Milk\n- [x] Eggs');

  // The choice to view this page is remembered.
  await page.reload();
  await expect(page.getByText('2 of 3 done')).toBeVisible();
});

test('the recipe view scales amounts and walks through the steps', async ({ page }) => {
  const nb = await createNotebook(page, uniq('Layouts NB'));
  const doc = await createPage(page, {
    notebookId: nb.id,
    title: uniq('Pancakes'),
    content: 'Servings: 2\n\n## Ingredients\n- 200 g flour\n- 2 eggs\n\n## Instructions\n1. Whisk the flour and eggs for 2 minutes.\n2. Fry in a hot pan.',
  });

  await openView(page, doc.id);
  await expect(page.getByRole('combobox', { name: 'Layout' }).locator('option:checked')).toHaveText('Automatic · Recipe');
  await expect(page.getByText('2 servings')).toBeVisible();
  await page.getByRole('button', { name: 'More servings' }).click();
  await expect(page.getByText('3 servings')).toBeVisible();
  await expect(page.getByLabel('Ingredients')).toContainText('300 g flour');
  await expect(page.getByLabel('Ingredients')).toContainText('3 eggs');

  await page.getByRole('button', { name: 'Start cooking' }).click();
  const runner = page.getByRole('dialog');
  await expect(runner).toContainText('Step 1 of 2');
  await expect(runner.getByRole('button', { name: '2 minutes' })).toBeVisible();
  await expect(runner).toContainText('300 g flour'); // "You need" for this step
  await page.keyboard.press('ArrowRight');
  await expect(runner).toContainText('Step 2 of 2');
  await page.keyboard.press('Escape');
  await expect(runner).toHaveCount(0);
});

test('a layout can be chosen by hand and set back to automatic', async ({ page }) => {
  const nb = await createNotebook(page, uniq('Layouts NB'));
  const doc = await createPage(page, { notebookId: nb.id, title: uniq('Notes'), content: '- One\n- Two\n- Three' });

  await openView(page, doc.id);
  const pick = page.getByRole('combobox', { name: 'Layout' });
  await pick.selectOption('steps');
  await expect(page.getByText('Chosen by you')).toBeVisible();
  await expect(page.getByText('3 steps')).toBeVisible();

  await pick.selectOption('');
  await expect(page.getByText('Detected automatically')).toBeVisible();
});

test('tables of numbers are drawn as charts, a value per point on hover', async ({ page }) => {
  const nb = await createNotebook(page, uniq('Layouts NB'));
  const table = ['| Date | Weight (kg) | Note |', '| --- | --- | --- |', '| 2026-10-01 | 81,4 | start |', '| 2026-10-08 | 80.9 | |', '| 2026-10-15 | 80.2 | |', '| 2026-10-22 | 79.6 | holiday |'];
  const doc = await createPage(page, { notebookId: nb.id, title: uniq('Weight'), content: table.join('\n') });

  await openView(page, doc.id);
  await expect(page.getByRole('combobox', { name: 'Layout' })).toHaveValue('');
  await expect(page.locator('.layout-data')).toBeVisible();
  // One chart per numeric column; the text column is left out.
  // Numbers are shown the browser's way ("79.6" or "79,6").
  const chart = page.getByRole('img', { name: /^Weight \(kg\): 4 values from 79[.,]6 to 81[.,]4$/ });
  await expect(chart).toBeVisible();
  await expect(page.locator('.chart-card')).toHaveCount(1);
  const box = (await chart.boundingBox())!;
  await page.mouse.move(box.x + box.width - 14, box.y + box.height / 2);
  await expect(page.locator('.chart-tip')).toContainText('2026-10-22');
  await expect(page.locator('.chart-tip')).toContainText(/79[.,]6 kg/);
  // The table itself stays below the charts.
  await expect(page.getByRole('table')).toContainText('holiday');
});
