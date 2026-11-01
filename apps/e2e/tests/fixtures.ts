import { expect, type Locator, type Page } from '@playwright/test';

/** The account the main test server creates on start (NICOTES_ADMIN_USER / _PASSWORD). */
export const ADMIN = { username: 'e2e', password: 'e2e-password-123' };

/** The account of the server for sign-in security tests (two-step sign-in, passkeys). */
export const SECURE = { username: 'guarded', password: 'guarded-password-123' };

/** All tests share one server and account, so every title they create is unique. */
export function uniq(prefix: string): string {
  return `${prefix} ${Math.random().toString(36).slice(2, 8)}`;
}

interface Notebook {
  id: string;
  title: string;
}

interface ApiPage {
  id: string;
  notebookId: string;
  parentId: string | null;
  title: string;
  content: string;
  version: number;
}

/** Creates test data through the API with the browser context's session. */
export async function createNotebook(page: Page, title: string): Promise<Notebook> {
  const res = await page.request.post('/api/notebooks', { data: { title } });
  expect(res.ok(), await res.text()).toBe(true);
  return res.json();
}

export async function createPage(
  page: Page,
  input: { notebookId: string; title: string; content?: string; parentId?: string | null },
): Promise<ApiPage> {
  const res = await page.request.post('/api/pages', { data: input });
  expect(res.ok(), await res.text()).toBe(true);
  return res.json();
}

export async function getPage(page: Page, id: string): Promise<ApiPage> {
  const res = await page.request.get(`/api/pages/${id}`);
  expect(res.ok(), await res.text()).toBe(true);
  return res.json();
}

export const sidebar = (page: Page) => page.getByRole('complementary', { name: 'Navigation' });

/** A notebook or page row in the sidebar tree, found by its title link. */
export function treeRow(page: Page, title: string): Locator {
  return sidebar(page).getByRole('link', { name: title, exact: true }).locator('xpath=..');
}

/** Opens a row's "⋯" menu and picks an entry. */
export async function rowMenu(page: Page, title: string, item: string) {
  const row = treeRow(page, title);
  await row.hover();
  await row.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: item, exact: true }).click();
}

export const visualEditor = (page: Page) => page.getByRole('textbox', { name: 'Page content' });
export const sourceEditor = (page: Page) => page.getByRole('textbox', { name: 'Markdown source' });
export const saveStatus = (page: Page) => page.locator('.page-bar').getByRole('status');

/** Waits for the autosave after an edit: the indicator leaves "Saved" and comes back. */
export async function waitForSave(page: Page) {
  await expect(saveStatus(page)).not.toHaveText('Saved');
  await expect(saveStatus(page)).toHaveText('Saved');
}
