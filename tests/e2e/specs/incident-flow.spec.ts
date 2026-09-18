import { expect, test, type Browser, type Page } from '@playwright/test';

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

async function createOrganization(page: Page, name: string): Promise<string> {
  await page.getByLabel('Organization name').fill(name);
  await page.getByRole('button', { name: 'Create organization' }).click();
  await expect(page).toHaveURL(/\/orgs\/[0-9a-f-]{36}$/);
  return new URL(page.url()).pathname.split('/').pop()!;
}

const nav = (page: Page, name: string) =>
  page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name, exact: true });

test('project → service → incident → acknowledge → assign → comment → resolve, with a live timeline and dashboard', async ({
  page,
}) => {
  await signUp(page, 'Ada Lovelace', `e2e-${unique()}@example.com`);
  await createOrganization(page, `Incident Org ${unique()}`);

  // Empty states first: nothing exists yet.
  await expect(page.getByText('No services yet')).toBeVisible();
  await expect(page.getByLabel('0 active incidents')).toHaveText('0');
  await nav(page, 'Projects').click();
  await expect(page.getByText('No projects yet')).toBeVisible();

  // Create a project and a service.
  await page.getByRole('button', { name: 'New project' }).click();
  await page.getByLabel('Name', { exact: true }).fill('Payments API');
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.getByRole('link', { name: 'Payments API' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Payments API' })).toBeVisible();
  await expect(page.getByText('No services yet')).toBeVisible();
  await page.getByRole('button', { name: 'Add service' }).click();
  await page.getByLabel('Name', { exact: true }).fill('Checkout API');
  await page.getByRole('button', { name: 'Create service' }).click();
  await expect(page.getByRole('cell', { name: 'Checkout API', exact: true })).toBeVisible();
  await expect(page.getByText('Not monitored')).toBeVisible(); // honest: no monitoring yet

  // Open an incident against that service.
  await nav(page, 'Incidents').click();
  await expect(page.getByText('No active incidents').first()).toBeVisible();
  await page.getByRole('button', { name: 'Open incident' }).click();
  await page.getByLabel('Title', { exact: true }).fill('API latency spike');
  await page.locator('#incident-severity').selectOption('SEV2');
  await page.locator('#incident-service').selectOption({ index: 1 });
  await page.getByLabel('Description').fill('p99 latency tripled after the last deploy');
  await page.getByLabel('Tags').fill('latency, api');
  await page.getByRole('button', { name: 'Open incident' }).click();

  // Incident detail: numbered, typed severity, status, timeline with the creation event.
  await expect(page).toHaveURL(/\/incidents\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('heading', { level: 1, name: 'API latency spike' })).toBeVisible();
  await expect(page.getByText('INC-1', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('SEV-2', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('p99 latency tripled after the last deploy')).toBeVisible();
  const timeline = page.getByRole('list', { name: 'Incident timeline' });
  await expect(timeline.getByText('opened this incident')).toBeVisible();

  // Only legal actions are offered for an OPEN incident.
  const actions = page.getByRole('group', { name: 'Incident actions' });
  await expect(actions.getByRole('button', { name: 'Acknowledge' })).toBeVisible();
  await expect(actions.getByRole('button', { name: 'Resolve' })).toHaveCount(0);

  // Acknowledge.
  await actions.getByRole('button', { name: 'Acknowledge' }).click();
  await expect(timeline.getByText('changed status from Open to Acknowledged')).toBeVisible();
  await expect(actions.getByRole('button', { name: 'Resolve' })).toBeVisible();

  // Assign yourself.
  await expect(page.getByText('Nobody is assigned yet.')).toBeVisible();
  await page.getByLabel('Assign a member').selectOption({ index: 1 });
  await expect(page.getByRole('button', { name: /Unassign Ada Lovelace/ })).toBeVisible();
  await expect(timeline.getByText('assigned Ada Lovelace')).toBeVisible();

  // Comment.
  await page.getByLabel('Add a comment').fill('Rolled back v1.4.3, watching the graphs');
  await page.getByRole('button', { name: 'Comment', exact: true }).click();
  await expect(timeline.getByText('Rolled back v1.4.3, watching the graphs')).toBeVisible();

  // Change severity.
  await page.locator('#severity').selectOption('SEV1');
  await expect(timeline.getByText('changed severity from SEV-2 to SEV-1')).toBeVisible();

  // Resolve, then only "Reopen" remains.
  await actions.getByRole('button', { name: 'Resolve' }).click();
  await expect(timeline.getByText('changed status from Acknowledged to Resolved')).toBeVisible();
  await expect(actions.getByRole('button', { name: 'Reopen' })).toBeVisible();
  await expect(actions.getByRole('button', { name: 'Resolve' })).toHaveCount(0);

  // The dashboard reflects reality: no active incidents, the resolved one is in "recent".
  await nav(page, 'Overview').click();
  await expect(page.getByLabel('0 active incidents')).toHaveText('0');
  await expect(page.getByRole('link', { name: /API latency spike/ }).first()).toBeVisible();
  await expect(
    page.getByText('Deployments appear here once a GitHub repository is connected', {
      exact: false,
    }),
  ).toBeVisible();

  // The list filters by status and searches by title and number.
  await nav(page, 'Incidents').click();
  await expect(page.getByText('No active incidents').first()).toBeVisible();
  await page.getByLabel('Status').selectOption('RESOLVED');
  await expect(page.getByRole('link', { name: /API latency spike/ })).toBeVisible();
  await page.getByLabel('Search incidents').fill('INC-1');
  await expect(page.getByRole('link', { name: /API latency spike/ })).toBeVisible();
  await page.getByLabel('Search incidents').fill('nothing-like-this');
  await expect(page.getByText('No incidents match these filters')).toBeVisible();
});

async function newUserContext(browser: Browser) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const email = `e2e-${unique()}@example.com`;
  await signUp(page, 'Read Only', email);
  return { context, page, email };
}

test('a VIEWER can read incidents but neither the UI nor the API lets them change anything', async ({
  browser,
}) => {
  const owner = await browser.newContext();
  const ownerPage = await owner.newPage();
  await signUp(ownerPage, 'Olivia Owner', `e2e-${unique()}@example.com`);
  const orgId = await createOrganization(ownerPage, `Viewer Org ${unique()}`);

  const created = await owner.request.post(`/api/v1/orgs/${orgId}/incidents`, {
    data: { title: 'Database connection pool exhausted', severity: 'SEV1' },
    headers: { Origin: ORIGIN },
  });
  expect(created.status()).toBe(201);
  const incident = await created.json();

  const viewer = await newUserContext(browser);
  const added = await owner.request.post(`/api/v1/orgs/${orgId}/members`, {
    data: { email: viewer.email, role: 'VIEWER' },
    headers: { Origin: ORIGIN },
  });
  expect(added.status()).toBe(201);

  // UI: they can see the incident but there are no write controls.
  await viewer.page.goto(`/orgs/${orgId}/incidents`);
  await expect(
    viewer.page.getByRole('link', { name: /Database connection pool exhausted/ }),
  ).toBeVisible();
  await expect(viewer.page.getByRole('button', { name: 'Open incident' })).toHaveCount(0);

  await viewer.page.goto(`/orgs/${orgId}/incidents/${incident.id}`);
  await expect(
    viewer.page.getByRole('heading', { level: 1, name: 'Database connection pool exhausted' }),
  ).toBeVisible();
  await expect(
    viewer.page.getByText('You do not have permission to change the status of this incident.'),
  ).toBeVisible();
  await expect(viewer.page.getByLabel('Add a comment')).toHaveCount(0);
  await expect(viewer.page.getByLabel('Assign a member')).toHaveCount(0);

  await viewer.page.goto(`/orgs/${orgId}/projects`);
  await expect(viewer.page.getByRole('button', { name: 'New project' })).toHaveCount(0);

  // API: the server refuses regardless of what the UI shows.
  const api = viewer.context.request;
  const headers = { Origin: ORIGIN };
  expect(
    (
      await api.post(`/api/v1/orgs/${orgId}/incidents`, {
        data: { title: 'x', severity: 'SEV4' },
        headers,
      })
    ).status(),
  ).toBe(403);
  expect(
    (
      await api.post(`/api/v1/orgs/${orgId}/incidents/${incident.id}/transitions`, {
        data: { to: 'ACKNOWLEDGED' },
        headers,
      })
    ).status(),
  ).toBe(403);
  expect(
    (
      await api.post(`/api/v1/orgs/${orgId}/incidents/${incident.id}/comments`, {
        data: { body: 'hi' },
        headers,
      })
    ).status(),
  ).toBe(403);
  expect(
    (await api.post(`/api/v1/orgs/${orgId}/projects`, { data: { name: 'x' }, headers })).status(),
  ).toBe(403);

  await owner.close();
  await viewer.context.close();
});
