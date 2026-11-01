import { expect, test } from '@playwright/test';
import { makePdf } from '../../server/test/pdf';
import { createNotebook, createPage, uniq } from './fixtures';

test('finds a page by the text of a PDF it shows', async ({ page }) => {
  const word = `quokka${Math.random().toString(36).slice(2, 7)}`;
  const upload = await page.request.post('/api/attachments', {
    headers: { 'x-requested-with': 'nicotes' },
    multipart: { file: { name: 'lease.pdf', mimeType: 'application/pdf', buffer: makePdf([`Lease agreement, pets allowed: one ${word}`]) } },
  });
  const { url } = (await upload.json()) as { url: string };
  const notebook = await createNotebook(page, uniq('Home'));
  const flat = await createPage(page, { notebookId: notebook.id, title: uniq('Flat'), content: `[The lease](${url})` });

  await page.goto('/');
  await page.keyboard.press('Control+k');
  await page.getByPlaceholder('Search pages, #tags and content…').fill(word);
  const hit = page.getByRole('option', { name: new RegExp(flat.title) });
  await expect(hit).toContainText('lease.pdf');
  await expect(hit.locator('mark')).toHaveText(word);
  await hit.click();
  await expect(page.getByLabel('Page title')).toHaveValue(flat.title);
});
