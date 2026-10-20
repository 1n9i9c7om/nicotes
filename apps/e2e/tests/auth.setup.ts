import { join } from 'node:path';
import { expect, test as setup } from '@playwright/test';
import { ADMIN } from './fixtures';

// Signs in once; the other tests start from this session.
setup('sign in', async ({ page }) => {
  const res = await page.request.post('/api/auth/login', { data: ADMIN });
  expect(res.ok(), await res.text()).toBe(true);
  await page.context().storageState({ path: join(import.meta.dirname, '../.auth/user.json') });
});
