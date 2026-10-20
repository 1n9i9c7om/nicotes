import { expect, test } from '@playwright/test';
import { createNotebook, createPage, getPage, uniq, visualEditor } from './fixtures';

test('links an unlinked mention from the Connections panel', async ({ page }) => {
  const nb = await createNotebook(page, uniq('Mentions NB'));
  const target = await createPage(page, { notebookId: nb.id, title: uniq('Sourdough'), content: 'Flour, water, salt.' });
  const mentioner = await createPage(page, {
    notebookId: nb.id,
    title: uniq('Baking log'),
    content: `Fed the ${target.title} starter today.`,
  });

  await page.goto(`/p/${target.id}`);
  const connections = page.getByRole('region', { name: 'Connections' });
  await connections.getByRole('tab', { name: /Unlinked mentions/ }).click();
  const row = connections.getByRole('listitem').filter({ hasText: mentioner.title });
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: 'Link' }).click();

  // The mention became a backlink.
  await expect(connections.getByRole('tab', { name: /Unlinked mentions/ })).toHaveCount(0);
  await expect(connections.getByRole('tab', { name: /Linked from/ })).toBeVisible();
  await expect(connections.getByRole('link', { name: new RegExp(mentioner.title) })).toBeVisible();
  expect((await getPage(page, mentioner.id)).content).toBe(`Fed the [[${target.title}]] starter today.`);
});

test('links a page this page names, and the backlink shows on the other side', async ({ page }) => {
  const nb = await createNotebook(page, uniq('Outgoing NB'));
  const target = await createPage(page, { notebookId: nb.id, title: uniq('Rye bread'), content: 'Dense.' });
  const doc = await createPage(page, { notebookId: nb.id, title: uniq('Plans'), content: `Bake ${target.title} on Sunday.` });

  await page.goto(`/p/${doc.id}`);
  const connections = page.getByRole('region', { name: 'Connections' });
  await connections.getByRole('tab', { name: /Unlinked mentions/ }).click();
  await connections.getByRole('button', { name: new RegExp(target.title) }).click();

  await expect(visualEditor(page).getByText(target.title)).toBeVisible();
  await expect.poll(async () => (await getPage(page, doc.id)).content).toBe(`Bake [[${target.title}]] on Sunday.`);

  await page.goto(`/p/${target.id}`);
  const backlinks = page.getByRole('region', { name: 'Connections' });
  await expect(backlinks.getByRole('tab', { name: /Linked from/ })).toBeVisible();
  await expect(backlinks.getByRole('link', { name: new RegExp(doc.title) })).toBeVisible();
});
