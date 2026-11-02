import { expect, test } from '@playwright/test';
import { caretToEnd, createNotebook, createPage, getPage, uniq, visualEditor, waitForSave } from './fixtures';

test('a page shows another page, or one of its sections, embedded', async ({ page }) => {
  const nb = await createNotebook(page, uniq('Embeds NB'));
  const bread = await createPage(page, {
    notebookId: nb.id,
    title: uniq('Bread'),
    content: '## Flour\n\nRye from the mill\n\n## Steps\n\n1. Mix everything\n2. Bake hot\n\n## Notes\n\nSecret notes',
  });
  const hub = await createPage(page, { notebookId: nb.id, title: uniq('Hub'), content: `Intro\n\n![[${bread.title}#Steps]]\n\nOutro` });

  await page.goto(`/p/${hub.id}`);
  const embed = visualEditor(page).locator('.embed');
  await expect(embed.getByRole('link', { name: `${bread.title} › Steps` })).toBeVisible();
  await expect(embed).toContainText('Mix everything');
  await expect(embed).not.toContainText('Rye from the mill');
  await expect(embed).not.toContainText('Secret notes');

  // "!" and a picked page on a line of their own make an embed.
  await visualEditor(page).getByText('Outro').click();
  await caretToEnd(page);
  await page.keyboard.press('Enter');
  await page.keyboard.type('![[');
  await page.keyboard.type(bread.title);
  await expect(page.getByRole('option', { name: new RegExp(bread.title) })).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Enter');
  await waitForSave(page);
  expect((await getPage(page, hub.id)).content).toBe(`Intro\n\n![[${bread.title}#Steps]]\n\nOutro\n\n![[${bread.title}]]`);
  await expect(visualEditor(page).locator('.embed').last()).toContainText('Secret notes');

  // The heading of an embed opens the page.
  await embed.getByRole('link', { name: `${bread.title} › Steps` }).click();
  await expect(page).toHaveURL(new RegExp(`/p/${bread.id}$`));
});
