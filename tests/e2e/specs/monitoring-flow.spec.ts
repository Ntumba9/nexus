import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

const PASSWORD = 'correct horse battery staple';
const ORIGIN = process.env.E2E_BASE_URL ?? 'http://localhost:3000';
const TARGET = 'http://127.0.0.1:4100';
const unique = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

async function setTarget(request: APIRequestContext, status: number): Promise<void> {
  const res = await request.get(`${TARGET}/__set?status=${status}`);
  expect(res.ok()).toBe(true);
}

/** Reload the page until `assertion` passes: the UI polls, but tests should not wait for a poll. */
async function eventually(
  page: Page,
  assertion: () => Promise<void>,
  timeout = 45_000,
): Promise<void> {
  await expect(async () => {
    await page.reload();
    await assertion();
  }).toPass({ timeout, intervals: [1000, 1500, 2000] });
}

test('a failing service is detected, an incident is opened automatically, and recovery is recorded', async ({
  page,
  request,
}) => {
  test.setTimeout(150_000);
  await setTarget(request, 500); // the outage begins before we even configure monitoring

  // Set up an organization, project and service (via the API: this test is about monitoring).
  await page.goto('/register');
  await page.getByLabel('Name', { exact: true }).fill('Monitor Tester');
  await page.getByLabel('Email', { exact: true }).fill(`e2e-${unique()}@example.com`);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL(/\/onboarding$/);
  await page.getByLabel('Organization name').fill(`Monitoring Org ${unique()}`);
  await page.getByRole('button', { name: 'Create organization' }).click();
  await expect(page).toHaveURL(/\/orgs\/[0-9a-f-]{36}$/);
  const orgId = new URL(page.url()).pathname.split('/').pop()!;

  const headers = { Origin: ORIGIN };
  const project = await (
    await page.request.post(`/api/v1/orgs/${orgId}/projects`, {
      data: { name: 'Storefront' },
      headers,
    })
  ).json();
  const service = await (
    await page.request.post(`/api/v1/orgs/${orgId}/projects/${project.id}/services`, {
      data: { name: 'Checkout API' },
      headers,
    })
  ).json();

  // Before monitoring exists the dashboard says so honestly.
  await expect(page.getByText('Not monitored').first()).toBeVisible();

  // Add a health check through the UI.
  await page.goto(`/orgs/${orgId}/services/${service.id}`);
  const monitoring = page.getByRole('region', { name: 'Monitoring' });
  await expect(page.getByText('This service is not monitored')).toBeVisible();
  await page.getByRole('button', { name: 'Add health check' }).click();
  await page.getByLabel('Name', { exact: true }).fill('Target health');
  await page.getByLabel('URL', { exact: true }).fill(`${TARGET}/health`);
  await page.getByText('Schedule, thresholds and incident settings').click();
  await page.getByLabel('Check every (seconds)').fill('15');
  await page.getByLabel('Down after N consecutive failures').fill('2');
  await page.getByLabel('Recovered after N consecutive successes').fill('1');
  await page.getByRole('button', { name: 'Add check' }).click();
  await expect(page.getByRole('heading', { name: 'Target health' })).toBeVisible();

  // First failure is seen but is NOT yet an outage (threshold is 2): a streak, no incident.
  await eventually(page, async () => {
    await expect(page.getByText('Failing streak')).toBeVisible({ timeout: 1500 });
  });
  await expect(monitoring.getByText('Down', { exact: true })).toHaveCount(0);

  // Second failure crosses the threshold: the check, then the service, is DOWN.
  await page.getByRole('button', { name: 'Check Target health now' }).click();
  await eventually(page, async () => {
    await expect(monitoring.getByText('Down', { exact: true })).toBeVisible({ timeout: 1500 });
  });

  // Results show why.
  await page.getByRole('button', { name: 'Show results' }).click();
  const results = page.getByRole('table', { name: 'Recent results' });
  await expect(results.getByText('Unexpected status code').first()).toBeVisible();
  await expect(results.getByText('500').first()).toBeVisible();

  // An incident was opened by monitoring, exactly one, with the right service and severity.
  await page.goto(`/orgs/${orgId}/incidents`);
  const incidentLink = page.getByRole('link', { name: /Checkout API \(production\) is down/ });
  await expect(incidentLink).toHaveCount(1);
  await incidentLink.click();
  await expect(
    page.getByRole('heading', { level: 1, name: 'Checkout API (production) is down' }),
  ).toBeVisible();
  await expect(page.getByText('automatically by monitoring')).toBeVisible();
  await expect(page.getByText('SEV-2', { exact: true }).first()).toBeVisible();
  const timeline = page.getByRole('list', { name: 'Incident timeline' });
  await expect(timeline.getByText('opened this incident (detected by monitoring)')).toBeVisible();
  await expect(page.getByText('failed 2 times in a row')).toBeVisible();
  const incidentUrl = page.url();

  // The overview reflects the outage.
  await page.goto(`/orgs/${orgId}`);
  await expect(page.getByLabel('1 active incidents')).toHaveText('1');

  // The service recovers; monitoring notices and annotates the incident but does not close it.
  await setTarget(request, 200);
  await page.goto(`/orgs/${orgId}/services/${service.id}`);
  await page.getByRole('button', { name: 'Check Target health now' }).click();
  await eventually(page, async () => {
    await expect(monitoring.getByText('Healthy', { exact: true })).toBeVisible({ timeout: 1500 });
  });

  await page.goto(incidentUrl);
  await expect(
    page
      .getByRole('list', { name: 'Incident timeline' })
      .getByText(/observed that “Target health” recovered/),
  ).toBeVisible();
  await expect(
    page
      .getByRole('group', { name: 'Incident actions' })
      .getByRole('button', { name: 'Acknowledge' }),
  ).toBeVisible(); // still OPEN

  // A human confirms and resolves it.
  await page.getByRole('button', { name: 'Acknowledge' }).click();
  await page.getByRole('button', { name: 'Resolve' }).click();
  await expect(
    page.getByRole('group', { name: 'Incident actions' }).getByRole('button', { name: 'Reopen' }),
  ).toBeVisible();
});

test('server-side URL validation errors are shown next to the URL field', async ({ page }) => {
  // (Private-address refusal itself is covered by API integration tests; the E2E environment runs
  // with the operator opt-in ON because its test target lives on localhost.)
  await page.goto('/register');
  await page.getByLabel('Name', { exact: true }).fill('URL Tester');
  await page.getByLabel('Email', { exact: true }).fill(`e2e-${unique()}@example.com`);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByLabel('Organization name').fill(`URL Org ${unique()}`);
  await page.getByRole('button', { name: 'Create organization' }).click();
  await expect(page).toHaveURL(/\/orgs\/[0-9a-f-]{36}$/);
  const orgId = new URL(page.url()).pathname.split('/').pop()!;
  const headers = { Origin: ORIGIN };
  const project = await (
    await page.request.post(`/api/v1/orgs/${orgId}/projects`, { data: { name: 'P' }, headers })
  ).json();
  const service = await (
    await page.request.post(`/api/v1/orgs/${orgId}/projects/${project.id}/services`, {
      data: { name: 'S' },
      headers,
    })
  ).json();

  await page.goto(`/orgs/${orgId}/services/${service.id}`);
  await page.getByRole('button', { name: 'Add health check' }).click();
  await page.getByLabel('Name', { exact: true }).fill('Bad scheme');
  await page.getByLabel('URL', { exact: true }).fill('ftp://example.com/health');
  await page.getByRole('button', { name: 'Add check' }).click();
  // Rejected server-side (only http/https are allowed) and shown next to the field.
  await expect(page.getByText('Only http:// and https:// URLs can be monitored')).toBeVisible();
  await expect(page.getByText('This service is not monitored')).toBeHidden();
});
