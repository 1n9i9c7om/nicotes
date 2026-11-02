import { expect, test } from '@playwright/test';
import type { ModelInfo, ModelList } from '@nicotes/shared';

const model = (m: Partial<ModelInfo> & Pick<ModelInfo, 'id' | 'name' | 'provider'>): ModelInfo => ({
  promptPrice: 0.5,
  completionPrice: 2,
  contextLength: 128_000,
  tools: false,
  reasoning: false,
  free: false,
  ...m,
});

const list: ModelList = {
  models: [
    model({ id: 'deepseek/deepseek-chat', name: 'DeepSeek: DeepSeek V3', provider: 'openrouter', tools: true }),
    model({ id: 'routeway:deepseek-v4.1-flash', name: 'DeepSeek: V4.1 Flash', provider: 'routeway', reasoning: true }),
    model({ id: 'meta/llama:free', name: 'Meta: Llama', provider: 'openrouter', promptPrice: 0, completionPrice: 0, free: true }),
  ],
  errors: [],
};

test('picks a Routeway model for one feature and goes back to the default', async ({ page }) => {
  // The lists come from OpenRouter and Routeway; the test serves a fixed one.
  await page.route('**/api/settings/models?kind=chat*', (route) => route.fulfill({ json: list }));
  await page.goto('/settings#models');

  const picker = page.getByRole('button', { name: 'Page assistant' });
  await picker.click();
  const options = page.getByRole('listbox', { name: 'Page assistant' }).getByRole('option');
  await expect(options).toHaveCount(4); // "Use the default model" + 3 models
  await page.getByRole('group', { name: 'Services' }).getByRole('button', { name: 'Routeway' }).click();
  await expect(options).toHaveCount(2);
  await page.getByRole('group', { name: 'Services' }).getByRole('button', { name: 'All services' }).click();
  await page.getByRole('group', { name: 'Capabilities' }).getByRole('button', { name: 'Free' }).click();
  await expect(options.filter({ hasText: 'Meta: Llama' })).toHaveCount(1);
  await page.getByRole('group', { name: 'Capabilities' }).getByRole('button', { name: 'All' }).click();

  await page.getByRole('textbox', { name: 'Search models' }).fill('v4.1');
  await expect(options).toHaveCount(1);
  await expect(options.first()).toContainText('128k context · $0.500 in / $2.00 out per 1M');
  await page.keyboard.press('Enter');
  await expect(picker).toContainText('DeepSeek: V4.1 Flash');
  await expect(picker).toContainText('Routeway');
  await expect
    .poll(async () => (await (await page.request.get('/api/settings')).json()).models.assistant.model)
    .toBe('routeway:deepseek-v4.1-flash');

  await picker.click();
  await page.getByRole('option', { name: /Use the default model/ }).click();
  await expect(picker).toContainText('Default ·');
  await expect.poll(async () => (await (await page.request.get('/api/settings')).json()).models.assistant.model).toBeNull();
});

test('sets up your own model server and picks one of its models', async ({ page }) => {
  const withLocal: ModelList = {
    models: [...list.models, model({ id: 'local:llama3.2', name: 'llama3.2', provider: 'local', promptPrice: 0, completionPrice: 0, contextLength: null, free: true })],
    errors: [],
  };
  await page.route('**/api/settings/models?kind=chat*', (route) => route.fulfill({ json: withLocal }));
  await page.route('**/api/settings/check', (route) => route.fulfill({ json: { ok: true, message: 'Reachable · 1 model installed' } }));
  await page.goto('/settings#local-models');

  const card = page.locator('#local-models');
  await card.getByLabel('Address').fill('http://ollama:11434/v1');
  await card.getByRole('button', { name: 'Save' }).first().click();
  await expect(card.getByText('Saved here')).toBeVisible();
  await card.getByRole('button', { name: 'Test connection' }).click();
  await expect(card.getByRole('status')).toHaveText('Reachable · 1 model installed');

  const picker = page.getByRole('button', { name: 'Summaries' });
  await picker.click();
  await page.getByRole('group', { name: 'Services' }).getByRole('button', { name: 'Own server' }).click();
  const options = page.getByRole('listbox', { name: 'Summaries' }).getByRole('option');
  await expect(options).toHaveCount(2); // "Use the default model" + llama3.2
  await options.filter({ hasText: 'llama3.2' }).click();
  await expect(picker).toContainText('Own server');
  await expect.poll(async () => (await (await page.request.get('/api/settings')).json()).models.summary.model).toBe('local:llama3.2');

  // Back to how the other tests expect it.
  await page.request.patch('/api/settings', { data: { localAiUrl: null, summaryModel: null } });
});

test('groups the settings in tabs that the address keeps', async ({ page }) => {
  await page.goto('/settings');
  const tabs = page.getByRole('tablist', { name: 'Settings' });
  const tab = (name: string) => tabs.getByRole('tab', { name, exact: true });
  await expect(tab('Account')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('heading', { name: 'Sign-in security' })).toBeVisible();
  await expect(page.locator('#models')).toHaveCount(0);

  await tab('AI').click();
  await expect(page).toHaveURL(/\/settings\/ai$/);
  await expect(page.getByRole('tabpanel', { name: 'AI' }).getByRole('heading', { name: 'AI models' })).toBeVisible();
  await expect(page.locator('#security')).toHaveCount(0);
  await page.reload();
  await expect(tab('AI')).toHaveAttribute('aria-selected', 'true');

  await tab('App & data').click();
  await expect(page.getByRole('heading', { name: 'About Nicotes' })).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/\/settings\/ai$/);
  await expect(page.locator('#models')).toBeVisible();

  // Arrow keys move between the tabs, Enter opens one.
  await tab('AI').focus();
  await page.keyboard.press('ArrowRight');
  await expect(tab('Integrations')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/settings\/integrations$/);
  await expect(page.locator('#reminders')).toBeVisible();

  // An unknown tab falls back to the first one.
  await page.goto('/settings/nothing-here');
  await expect(page).toHaveURL(/\/settings\/account$/);
  await expect(tab('Account')).toHaveAttribute('aria-selected', 'true');
});

test('a link to a section opens its tab and scrolls it below the tabs', async ({ page }) => {
  const tabs = page.getByRole('tablist', { name: 'Settings' });
  const belowTabs = async (id: string) => {
    await expect(page.locator(`#${id}`)).toBeInViewport();
    const bar = (await tabs.boundingBox())!;
    const card = (await page.locator(`#${id}`).boundingBox())!;
    // The tabs stay at the top; the card starts just below them.
    expect(bar.y).toBeCloseTo(0, 0);
    expect(card.y - (bar.y + bar.height)).toBeCloseTo(16, 0);
  };

  await page.goto('/settings#models');
  await expect(page).toHaveURL(/\/settings\/ai#models$/);
  await expect(tabs.getByRole('tab', { name: 'AI', exact: true })).toHaveAttribute('aria-selected', 'true');
  await belowTabs('models');

  // From another page of the app, and between tabs.
  await page.goto('/journal');
  await page.getByRole('link', { name: 'Daily note settings' }).click();
  await expect(page).toHaveURL(/\/settings\/notes#daily$/);
  await expect(page.locator('#daily')).toBeInViewport();
  await page.locator('#file-search').getByRole('link', { name: 'AI models' }).click();
  await expect(page).toHaveURL(/\/settings\/ai#models$/);
  await belowTabs('models');

  // Another tab opens at the top of the page, also from further down.
  await tabs.getByRole('tab', { name: 'Integrations' }).click();
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeInViewport();
  expect(await page.locator('.main').evaluate((main) => main.scrollTop)).toBe(0);
  await expect(page.locator('#reminders')).toBeInViewport();
});
