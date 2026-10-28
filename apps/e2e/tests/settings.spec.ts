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
  await page.getByRole('group', { name: 'Services' }).getByRole('button', { name: 'Both services' }).click();
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
