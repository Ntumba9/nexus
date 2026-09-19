import { defineConfig, devices } from '@playwright/test';

const WEB_URL = process.env.E2E_BASE_URL ?? 'http://localhost:3000';

/**
 * End-to-end tests run against the real, built application: PostgreSQL + Redis (must already be
 * running with migrations applied), the NestJS API and the Next.js server. Set E2E_NO_SERVER=1 to
 * test servers you started yourself.
 */
export default defineConfig({
  testDir: './specs',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: WEB_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: process.env.E2E_NO_SERVER
    ? undefined
    : [
        {
          command: 'pnpm --filter @nexus/api start',
          cwd: '../..',
          url: 'http://localhost:3001/health/ready',
          reuseExistingServer: !process.env.CI,
          timeout: 60_000,
        },
        {
          command: 'pnpm --filter @nexus/web start',
          cwd: '../..',
          url: 'http://localhost:3000/health',
          reuseExistingServer: !process.env.CI,
          timeout: 60_000,
        },
        {
          // The monitoring worker: scheduler + health-check processor. Needs PostgreSQL and Redis.
          command: 'pnpm --filter @nexus/workers start',
          cwd: '../..',
          url: 'http://localhost:3002/health/ready',
          reuseExistingServer: !process.env.CI,
          timeout: 60_000,
        },
        {
          // A tiny HTTP service whose status code the monitoring test flips to simulate an outage.
          command: 'node tests/e2e/support/target-server.mjs',
          cwd: '../..',
          url: 'http://127.0.0.1:4100/__ready',
          reuseExistingServer: !process.env.CI,
          timeout: 15_000,
        },
      ],
});
