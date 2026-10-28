import { expect, test, type Page } from '@playwright/test';
import type { AssistantEvent } from '@nicotes/shared';
import { createNotebook, createPage, getPage, uniq, visualEditor } from './fixtures';

const draft = 'Intro line\n\nFirst point\n\nMiddle part\n\nSecond point\n\nOutro line';

/** Answers the assistant endpoint with fixed server-sent events instead of calling a model. */
async function fakeAssistant(page: Page, events: AssistantEvent[]) {
  const requests: unknown[] = [];
  await page.route('**/api/ai/pages/*/assistant', async (route) => {
    requests.push(route.request().postDataJSON());
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      body: events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''),
    });
  });
  return requests;
}

test('restores only some changes of an earlier version', async ({ page }) => {
  const nb = await createNotebook(page, uniq('Partial NB'));
  const doc = await createPage(page, { notebookId: nb.id, title: uniq('Partial'), content: draft });
  // A later edit changes both points; the draft is kept as a version.
  const edited = draft.replace('First point', 'First point, reworded').replace('Second point', 'Second point, reworded');
  await page.request.patch(`/api/pages/${doc.id}`, { data: { content: edited, baseVersion: doc.version } });

  await page.goto(`/p/${doc.id}`);
  await page.getByRole('button', { name: 'Page actions' }).click();
  await page.getByRole('menuitem', { name: 'Version history' }).click();
  const dialog = page.getByRole('dialog', { name: 'Version history' });
  const diff = dialog.getByRole('group', { name: 'Changes from the current text to this version' });
  await expect(diff.getByRole('checkbox')).toHaveCount(2);
  await diff.getByRole('checkbox').nth(1).uncheck();
  await dialog.getByRole('button', { name: 'Restore 1 of 2 changes' }).click();
  await expect(dialog).toBeHidden();

  const expected = draft.replace('Second point', 'Second point, reworded');
  await expect.poll(async () => (await getPage(page, doc.id)).content).toBe(expected);
  await expect(visualEditor(page)).toContainText('Second point, reworded');
  await expect(visualEditor(page)).not.toContainText('First point, reworded');
});

test('the assistant proposes changes that are applied change by change', async ({ page }) => {
  const nb = await createNotebook(page, uniq('Assistant NB'));
  const doc = await createPage(page, { notebookId: nb.id, title: uniq('Assisted'), content: draft });
  const proposal = draft.replace('Intro line', 'A better intro').replace('Outro line', 'A better outro');
  const requests = await fakeAssistant(page, [
    { type: 'context', notes: [], web: [] },
    { type: 'delta', text: 'I rewrote the intro and the outro.' },
    { type: 'proposal', content: proposal },
    { type: 'done', cost: 0.001, model: 'test/model' },
  ]);

  await page.goto(`/p/${doc.id}`);
  await page.getByRole('button', { name: 'Assistant' }).click();
  const panel = page.getByRole('complementary', { name: 'Page assistant' });
  await expect(panel.getByLabel('Notes the assistant may read')).toHaveValue('page');
  await panel.getByPlaceholder('Ask or request a change…').fill('Improve the intro and outro');
  await panel.getByRole('button', { name: 'Send' }).click();

  await expect(panel).toContainText('I rewrote the intro and the outro.');
  expect(requests[0]).toMatchObject({ message: 'Improve the intro and outro', content: draft, scope: 'page', research: false });
  const review = panel.getByRole('group', { name: 'Proposed changes to this page' });
  await expect(review.getByRole('checkbox')).toHaveCount(2);
  // Nothing is written before the user applies.
  expect((await getPage(page, doc.id)).content).toBe(draft);

  await review.getByRole('checkbox').first().uncheck();
  await panel.getByRole('button', { name: 'Apply 1 of 2' }).click();
  await expect(panel).toContainText('Applied 1 of 2 changes');
  await expect.poll(async () => (await getPage(page, doc.id)).content).toBe(draft.replace('Outro line', 'A better outro'));
  await expect(visualEditor(page)).toContainText('A better outro');

  // The state before is in the history, labelled as such.
  await page.getByRole('button', { name: 'Page actions' }).click();
  await page.getByRole('menuitem', { name: 'Version history' }).click();
  await expect(page.getByRole('dialog', { name: 'Version history' }).getByRole('button', { name: /Before AI changes/ })).toBeVisible();
});
