import { expect, test, type Browser } from '@playwright/test';

const PASSWORD = 'correct horse battery staple';
const unique = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

async function signUpWithOrganization(browser: Browser, orgName: string) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto('/register');
  await page.getByLabel('Name', { exact: true }).fill('Tenant Owner');
  await page.getByLabel('Email', { exact: true }).fill(`e2e-${unique()}@example.com`);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL(/\/onboarding$/);
  await page.getByLabel('Organization name').fill(orgName);
  await page.getByRole('button', { name: 'Create organization' }).click();
  await expect(page).toHaveURL(/\/orgs\/[0-9a-f-]{36}$/);
  const orgId = new URL(page.url()).pathname.split('/').pop()!;
  return { context, page, orgId };
}

test('a user cannot open, or call the API for, another organization', async ({ browser }) => {
  const secretName = `Secret Org ${unique()}`;
  const a = await signUpWithOrganization(browser, secretName);
  const b = await signUpWithOrganization(browser, `Other Org ${unique()}`);

  // B navigates straight to A's URL: a plain "not found", revealing nothing about A.
  await b.page.goto(`/orgs/${a.orgId}`);
  await expect(b.page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
  await expect(b.page.getByText(secretName)).toHaveCount(0);

  await b.page.goto(`/orgs/${a.orgId}/settings`);
  await expect(b.page.getByRole('heading', { name: 'Page not found' })).toBeVisible();

  // B calls the API directly with their own valid session: still denied, identically to "unknown".
  const foreign = await b.context.request.get(`/api/v1/orgs/${a.orgId}`);
  const unknown = await b.context.request.get('/api/v1/orgs/00000000-0000-4000-8000-000000000000');
  expect(foreign.status()).toBe(404);
  expect(unknown.status()).toBe(404);
  expect((await foreign.json()).error.message).toBe((await unknown.json()).error.message);
  expect((await b.context.request.get(`/api/v1/orgs/${a.orgId}/members`)).status()).toBe(404);

  // A is unaffected and B's own organization works.
  await a.page.reload();
  await expect(a.page.getByRole('heading', { level: 1, name: secretName })).toBeVisible();
  const own = await b.context.request.get(`/api/v1/orgs/${b.orgId}`);
  expect(own.status()).toBe(200);

  await a.context.close();
  await b.context.close();
});

test('an organization switcher only offers the user’s own organizations', async ({ browser }) => {
  const a = await signUpWithOrganization(browser, `Alpha ${unique()}`);
  await a.page.getByRole('button', { name: 'Switch organization' }).click();
  await expect(a.page.getByRole('link', { name: '+ Create organization' })).toBeVisible();
  await expect(a.page.getByRole('link', { name: /OWNER/ })).toHaveCount(1);
  await a.context.close();
});
