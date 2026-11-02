import { expect, test } from '@playwright/test';
import { strToU8, zipSync } from 'fflate';
import { uniq } from './fixtures';

test('imports a zipped Obsidian vault into one notebook', async ({ page }) => {
  const vault = uniq('Garden');
  const zip = zipSync({
    [`${vault}/.obsidian/app.json`]: strToU8('{}'),
    [`${vault}/Inbox.md`]: strToU8('See [[Tomatoes]].'),
    [`${vault}/Plants/Tomatoes.md`]: strToU8('---\ntags: [vegetables]\n---\n# Tomatoes\n\nWater daily.'),
    [`${vault}/Plants/Basil.md`]: strToU8('Next to the [[Tomatoes|tomatoes]].'),
  });

  await page.goto('/import');
  const card = page.locator('.vault-import');
  await card.getByLabel('Vault zip').setInputFiles({ name: `${vault}.zip`, mimeType: 'application/zip', buffer: Buffer.from(zip) });
  await expect(card.getByText(`${vault}: 3 notes, 0 files, 1 tag`)).toBeVisible();
  await card.getByLabel(`Everything in one notebook, “${vault}”`).check();
  await card.getByRole('button', { name: 'Import 3 notes' }).click();
  await expect(card.getByText('Imported 4 pages, 0 files and 1 tag into')).toBeVisible();

  await card.getByRole('link', { name: vault }).click();
  await expect(page.getByRole('heading', { name: vault })).toBeVisible();
  await page.goto('/');
  await page.getByRole('link', { name: 'Tomatoes' }).first().click();
  await expect(page.getByLabel('Page title')).toHaveValue('Tomatoes');
  await expect(page.locator('.prose')).toHaveText('Water daily.');
});
