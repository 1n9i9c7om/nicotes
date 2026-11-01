import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, defineConfig, devices } from '@playwright/test';
import { ADMIN, SECURE } from './tests/fixtures';

const root = resolve(import.meta.dirname, '../..');
const serverEntry = join(root, 'apps/server/dist/index.js');

if (!existsSync(serverEntry) || !existsSync(join(root, 'apps/web/dist/index.html'))) {
  throw new Error('Nicotes is not built. Run `npm run e2e` from the repo root (it builds first), or `npm run build`.');
}

function freePort(): Promise<number> {
  return new Promise((ok, fail) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', fail);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => ok(port));
    });
  });
}

// The config is loaded again in every worker; values picked by the main process travel
// through the environment so all of them talk to the same servers.
if (!process.env.E2E_DATA_ROOT) {
  // Data dirs of earlier runs (the server still held the database when they ended).
  for (const name of readdirSync(tmpdir())) {
    if (name.startsWith('nicotes-e2e-')) rmSync(join(tmpdir(), name), { recursive: true, force: true, maxRetries: 2 });
  }
  const dir = join(tmpdir(), `nicotes-e2e-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  process.env.E2E_DATA_ROOT = dir;
  process.env.E2E_PORT = String(await freePort());
  process.env.E2E_SETUP_PORT = String(await freePort());
  process.env.E2E_SECURITY_PORT = String(await freePort());
}
const dataRoot = process.env.E2E_DATA_ROOT;
const port = Number(process.env.E2E_PORT);
const setupPort = Number(process.env.E2E_SETUP_PORT);
const securityPort = Number(process.env.E2E_SECURITY_PORT);

/** No AI feature may reach OpenRouter (or anything else) from the tests. */
const offline = {
  OPENROUTER_API_KEY: '',
  OPENROUTER_MODEL: '',
  NICOTES_SEMANTIC_INDEX: 'false',
  SEARXNG_URL: '',
  CRAWL4AI_URL: '',
  CRAWL4AI_TOKEN: '',
  NICOTES_SECRET: 'e2e-only-secret',
  // Any outbound request the server still makes goes to a dead proxy and fails fast.
  NODE_USE_ENV_PROXY: '1',
  HTTP_PROXY: 'http://127.0.0.1:9',
  HTTPS_PROXY: 'http://127.0.0.1:9',
  NO_PROXY: '127.0.0.1,localhost',
};

// Playwright's own Chromium when it is installed (`npx playwright install chromium`),
// otherwise the system's Microsoft Edge. E2E_CHANNEL overrides (e.g. "chrome", "msedge").
const channel = process.env.E2E_CHANNEL || (existsSync(chromium.executablePath()) ? undefined : 'msedge');

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : 4,
  reporter: process.env.CI ? 'github' : 'list',
  timeout: 30_000,
  expect: { timeout: 7_000 },
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    channel,
    // The PWA service worker would cache the app shell between tests.
    serviceWorkers: 'block',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'setup', testMatch: /auth\.setup\.ts/ },
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        channel,
        storageState: join(import.meta.dirname, '.auth/user.json'),
        // A fake microphone (a beep) without a permission prompt, for voice notes.
        launchOptions: { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] },
      },
      dependencies: ['setup'],
      testIgnore: /mobile\.spec\.ts/,
    },
    {
      name: 'mobile',
      use: { ...devices['Pixel 7'], channel, storageState: join(import.meta.dirname, '.auth/user.json') },
      dependencies: ['setup'],
      testMatch: /mobile\.spec\.ts/,
    },
  ],
  webServer: [
    {
      // The instance most tests use; its account comes from NICOTES_ADMIN_USER.
      command: `node "${serverEntry}"`,
      cwd: root,
      url: `http://127.0.0.1:${port}/api/health`,
      reuseExistingServer: false,
      stdout: 'ignore',
      stderr: 'pipe',
      env: {
        ...offline,
        NICOTES_PORT: String(port),
        DATA_DIR: join(dataRoot, 'main'),
        NICOTES_ADMIN_USER: ADMIN.username,
        NICOTES_ADMIN_PASSWORD: ADMIN.password,
      },
    },
    {
      // An empty instance without an account, for the first-run setup screen.
      command: `node "${serverEntry}"`,
      cwd: root,
      url: `http://127.0.0.1:${setupPort}/api/health`,
      reuseExistingServer: false,
      stdout: 'ignore',
      stderr: 'pipe',
      env: {
        ...offline,
        NICOTES_PORT: String(setupPort),
        DATA_DIR: join(dataRoot, 'setup'),
        NICOTES_ADMIN_USER: '',
        NICOTES_ADMIN_PASSWORD: '',
      },
    },
    {
      // Its own account for two-step sign-in and passkeys, which would get in the way of
      // tests signing in elsewhere.
      command: `node "${serverEntry}"`,
      cwd: root,
      url: `http://127.0.0.1:${securityPort}/api/health`,
      reuseExistingServer: false,
      stdout: 'ignore',
      stderr: 'pipe',
      env: {
        ...offline,
        NICOTES_PORT: String(securityPort),
        DATA_DIR: join(dataRoot, 'security'),
        NICOTES_ADMIN_USER: SECURE.username,
        NICOTES_ADMIN_PASSWORD: SECURE.password,
      },
    },
  ],
});
