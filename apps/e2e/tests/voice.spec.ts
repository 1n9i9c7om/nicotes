import { expect, test } from '@playwright/test';
import { createNotebook, createPage, uniq } from './fixtures';

test.use({ permissions: ['microphone'] });

test('records a voice note into a page, with a player', async ({ page }) => {
  const notebook = await createNotebook(page, uniq('Voice'));
  const target = await createPage(page, { notebookId: notebook.id, title: uniq('Errands'), content: 'Things to remember:' });

  await page.goto(`/p/${target.id}`);
  await page.getByText('Things to remember:').click();
  await page.getByRole('button', { name: 'Record a voice note' }).click();
  await expect(page.getByText(/Recording 0:0[2-9]/)).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: 'Stop and add' }).click();

  const link = page.locator('.prose a', { hasText: /Voice note \(0:0\d\)/ });
  await expect(link).toBeVisible();
  await expect(page.locator('.prose audio.voice-player')).toHaveAttribute('src', /\/api\/attachments\/.+\.(webm|m4a|ogg)$/);
  // Without a transcription service the recording is all there is, saved with the page.
  await expect(page.getByText('Saved')).toBeVisible();
  const saved = (await (await page.request.get(`/api/pages/${target.id}`)).json()) as { content: string };
  expect(saved.content).toMatch(/^Things to remember:\n\n\[🎙️ Voice note \(0:0\d\)\]\(\/api\/attachments\/[\w-]+\/Voice%20note%20.+\)$/);
});
