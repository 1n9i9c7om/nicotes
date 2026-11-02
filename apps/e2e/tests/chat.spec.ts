import { expect, test } from '@playwright/test';
import type { ChatAction, ChatEntry } from '@nicotes/shared';
import { createNotebook, createPage, sidebar, uniq } from './fixtures';

test('the chat is right below search, and old Ask links lead to it', async ({ page }) => {
  await page.goto('/');
  const entries = sidebar(page).locator('.sidebar-scroll > .nav-item');
  await expect(entries.nth(0)).toContainText('Search');
  await expect(entries.nth(1)).toHaveText('Chat');

  await page.goto('/ask?q=hello');
  await expect(page).toHaveURL(/\/chat/);
  await expect(page.getByRole('heading', { name: 'Chat' })).toBeVisible();
  // The test server has no AI service, so the chat says what it needs.
  await expect(page.getByRole('alert')).toContainText('The chat needs an OpenRouter API key');
  await expect(page.getByRole('button', { name: 'Send' })).toBeDisabled();
});

test('answers show what the assistant did in Nicotes, with links to the pages', async ({ page }) => {
  const nb = await createNotebook(page, uniq('Chat NB'));
  const car = await createPage(page, { notebookId: nb.id, title: uniq('Car'), content: 'Service in May' });
  // The test server has no AI service: a saved conversation stands in for one.
  const history: ChatEntry[] = [
    { id: 'u1', role: 'user', content: 'When is the car service?', actions: [], createdAt: 1 },
    {
      id: 'a1',
      role: 'assistant',
      content: 'In May, see [[Car]].',
      actions: [
        { tool: 'search_notes', summary: 'Searched for “car” (1 found)', ok: true },
        { tool: 'read_page', summary: `Read “${car.title}”`, pageId: car.id, ok: true },
        { tool: 'calendar', summary: 'calendar: The calendar is unavailable', ok: false },
      ],
      createdAt: 2,
    },
  ];
  await page.route('**/api/chat', (route) => (route.request().method() === 'GET' ? route.fulfill({ json: history }) : route.continue()));
  await page.goto('/chat');

  const steps = page.locator('.chat-msg.from-assistant .chat-actions li');
  await expect(steps).toHaveText(['Searched for “car” (1 found)', `Read “${car.title}”`, 'calendar: The calendar is unavailable']);
  await expect(steps.nth(2)).toHaveClass('failed');
  await steps.nth(1).getByRole('link').click();
  await expect(page).toHaveURL(new RegExp(`/p/${car.id}$`));
});

test('deleting a page waits for the user to confirm in the chat', async ({ page }) => {
  const question: ChatAction = {
    tool: 'delete_page',
    summary: 'Delete “Games › Old list”?',
    pageId: 'p1',
    ok: true,
    confirm: { id: 'c1', state: 'pending', yes: 'Move to trash', no: 'Keep it' },
  };
  const entry: ChatEntry = { id: 'a1', role: 'assistant', content: 'It waits for your confirmation.', actions: [question], createdAt: 2 };
  let answered: unknown;
  await page.route('**/api/chat', (route) => (route.request().method() === 'GET' ? route.fulfill({ json: [entry] }) : route.continue()));
  await page.route('**/api/chat/actions/c1', (route) => {
    answered = route.request().postDataJSON();
    const done: ChatAction = { ...question, summary: 'Moved “Old list” to the trash', confirm: { ...question.confirm!, state: 'done' } };
    return route.fulfill({ json: { ...entry, actions: [done] } });
  });
  await page.goto('/chat');

  const card = page.getByRole('group', { name: 'Delete “Games › Old list”?' });
  await expect(card.getByRole('button', { name: 'Keep it' })).toBeVisible();
  await card.getByRole('button', { name: 'Move to trash' }).click();
  await expect(page.locator('.chat-actions li')).toHaveText(['Moved “Old list” to the trash']);
  await expect(page.getByRole('button', { name: 'Move to trash' })).toHaveCount(0);
  expect(answered).toEqual({ confirm: true });
});
