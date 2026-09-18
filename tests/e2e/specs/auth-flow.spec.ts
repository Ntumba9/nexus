import { expect, test, type Page } from '@playwright/test';

const PASSWORD = 'correct horse battery staple';
const unique = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

async function register(page: Page, name: string, email: string): Promise<void> {
  await page.goto('/register');
  await page.getByLabel('Name', { exact: true }).fill(name);
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL(/\/onboarding$/);
}

async function createOrganization(page: Page, name: string): Promise<string> {
  await page.getByLabel('Organization name').fill(name);
  await page.getByRole('button', { name: 'Create organization' }).click();
  await expect(page).toHaveURL(/\/orgs\/[0-9a-f-]{36}$/);
  return new URL(page.url()).pathname;
}

test('register → create organization → dashboard → logout → login again', async ({ page }) => {
  const email = `e2e-${unique()}@example.com`;
  const orgName = `E2E Org ${unique()}`;

  // Anonymous visitors are sent to the login screen.
  await page.goto('/');
  await expect(page).toHaveURL(/\/login$/);
  await page.getByRole('link', { name: 'Create an account' }).click();
  await expect(page).toHaveURL(/\/register$/);

  // Register, then onboarding.
  await page.getByLabel('Name', { exact: true }).fill('Ada Lovelace');
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL(/\/onboarding$/);
  await expect(page.getByRole('heading', { name: /Welcome, Ada/ })).toBeVisible();

  // Create the organization and land on the authenticated dashboard.
  const orgPath = await createOrganization(page, orgName);
  await expect(page.getByRole('heading', { level: 1, name: orgName })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Settings' })).toBeVisible();
  await expect(page.getByText('You are owner in this organization.')).toBeVisible();

  // The session cookie is HttpOnly + SameSite=Lax, and invisible to page JavaScript.
  const session = (await page.context().cookies()).find((c) => c.name === 'nexus_session');
  expect(session?.httpOnly).toBe(true);
  expect(session?.sameSite).toBe('Lax');
  expect(await page.evaluate(() => document.cookie)).not.toContain('nexus_session');

  // Log out.
  await page.getByRole('button', { name: 'Account menu' }).click();
  await expect(page.getByText(email)).toBeVisible();
  await page.getByRole('button', { name: 'Log out' }).click();
  await expect(page).toHaveURL(/\/login$/);

  // The dashboard is no longer reachable.
  await page.goto(orgPath);
  await expect(page).toHaveURL(/\/login$/);

  // Log in again and return to the same organization.
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page).toHaveURL(new RegExp(`${orgPath}$`));
  await expect(page.getByRole('heading', { level: 1, name: orgName })).toBeVisible();
});

test('login shows one generic error for a wrong password and for an unknown email', async ({
  page,
}) => {
  const email = `e2e-${unique()}@example.com`;
  await register(page, 'Grace Hopper', email);
  await page.context().clearCookies();

  const attempt = async (address: string) => {
    await page.goto('/login');
    await page.getByLabel('Email', { exact: true }).fill(address);
    await page.getByLabel('Password', { exact: true }).fill('definitely the wrong password');
    await page.getByRole('button', { name: 'Log in' }).click();
    return page.getByRole('alert').filter({ hasText: 'Invalid email or password.' });
  };
  await expect(await attempt(email)).toBeVisible();
  await expect(await attempt(`nobody-${unique()}@example.com`)).toBeVisible();
});

test('registration validates input before submitting', async ({ page }) => {
  await page.goto('/register');
  await page.getByLabel('Name', { exact: true }).fill('Short Pass');
  await page.getByLabel('Email', { exact: true }).fill('not-an-email');
  await page.getByLabel('Password', { exact: true }).fill('short');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByText('Enter a valid email address')).toBeVisible();
  await expect(page.getByText(/at least 12 characters/i).first()).toBeVisible();
  await expect(page).toHaveURL(/\/register$/);
});
