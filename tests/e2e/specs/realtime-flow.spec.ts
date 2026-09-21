import { expect, test, type Page } from '@playwright/test';

const PASSWORD = 'correct horse battery staple';
const ORIGIN = process.env.E2E_BASE_URL ?? 'http://localhost:3000';
const unique = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

async function signUp(page: Page, name: string, email: string): Promise<void> {
  await page.goto('/register');
  await page.getByLabel('Name', { exact: true }).fill(name);
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL(/\/onboarding$/);
}

test('a change made in one tab appears in another without reloading', async ({ page, browser }) => {
  await signUp(page, 'Grace Hopper', `e2e-${unique()}@example.com`);
  await page.getByLabel('Organization name').fill(`Live Org ${unique()}`);
  await page.getByRole('button', { name: 'Create organization' }).click();
  await expect(page).toHaveURL(/\/orgs\/[0-9a-f-]{36}$/);
  const orgId = new URL(page.url()).pathname.split('/').pop()!;

  // The first tab watches the dashboard and reports that it is connected to the live stream.
  await expect(page.getByLabel('0 active incidents')).toHaveText('0');
  const indicator = page.getByRole('status').filter({ hasText: /Live|Polling/ });
  await expect(indicator).toContainText('Live', { timeout: 10_000 });

  // A second tab of the same person (a separate browser context sharing the session) opens an
  // incident. Nothing is done in the first tab.
  const secondTab = await browser.newContext({ storageState: await page.context().storageState() });
  const created = await secondTab.request.post(`${ORIGIN}/api/v1/orgs/${orgId}/incidents`, {
    headers: { Origin: ORIGIN },
    data: { title: 'Checkout is failing', severity: 'SEV1' },
  });
  expect(created.status()).toBe(201);

  // Polling is only a 60 s safety net while live, so seeing the change this fast means it was pushed.
  await expect(page.getByLabel('1 active incidents')).toHaveText('1', { timeout: 8_000 });

  // The stream stays healthy across further changes.
  await secondTab.request.post(`${ORIGIN}/api/v1/orgs/${orgId}/incidents`, {
    headers: { Origin: ORIGIN },
    data: { title: 'Search is slow', severity: 'SEV3' },
  });
  await expect(page.getByLabel('2 active incidents')).toHaveText('2', { timeout: 8_000 });
  await expect(indicator).toContainText('Live');
  await secondTab.close();
});

test('the app keeps working, on polling, when the stream is unavailable', async ({ page }) => {
  await signUp(page, 'Alan Turing', `e2e-${unique()}@example.com`);
  // Refuse the stream before opening an organisation; everything else must work as before.
  await page.route('**/api/v1/orgs/*/events', (route) => route.abort());
  await page.getByLabel('Organization name').fill(`Polling Org ${unique()}`);
  await page.getByRole('button', { name: 'Create organization' }).click();
  await expect(page).toHaveURL(/\/orgs\/[0-9a-f-]{36}$/);

  await expect(page.getByLabel('0 active incidents')).toHaveText('0');
  await expect(page.getByRole('status').filter({ hasText: /Live|Polling/ })).toContainText(
    'Polling',
  );
});
