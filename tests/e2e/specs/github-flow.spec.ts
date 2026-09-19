import { createHmac, randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';

const PASSWORD = 'correct horse battery staple';
const ORIGIN = process.env.E2E_BASE_URL ?? 'http://localhost:3000';
const unique = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const SHA = 'abcdef1234567890abcdef1234567890abcdef12';

/** Reload until `assertion` passes: the UI polls, but tests should not wait for a poll. */
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

const sign = (secret: string, body: string) =>
  'sha256=' + createHmac('sha256', secret).update(body).digest('hex');

test('a repository is connected, its deployments arrive signed, and one is confirmed as an incident cause', async ({
  page,
  request,
}) => {
  test.setTimeout(150_000);

  // An organization with a project and a service (via the API: this test is about GitHub).
  await page.goto('/register');
  await page.getByLabel('Name', { exact: true }).fill('Deploy Tester');
  await page.getByLabel('Email', { exact: true }).fill(`e2e-${unique()}@example.com`);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL(/\/onboarding$/);
  await page.getByLabel('Organization name').fill(`Deploy Org ${unique()}`);
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

  // Before anything is connected, the deployments page says so.
  await page.goto(`/orgs/${orgId}/deployments`);
  await expect(page.getByText('No deployments yet')).toBeVisible();

  // Connect a repository through the UI.
  await page.goto(`/orgs/${orgId}/integrations`);
  await page.getByLabel('Repository').fill('acme/storefront');
  await page.getByLabel('Project').selectOption({ label: 'Storefront' });
  await expect(page.getByLabel('Service').locator('option')).toHaveCount(2);
  await page.getByLabel('Service').selectOption({ label: 'Checkout API (production)' });
  await page.getByRole('button', { name: 'Connect repository' }).click();

  // The secret is shown once, with the URL GitHub should call.
  await expect(page.getByText('Connect acme/storefront in GitHub')).toBeVisible();
  const payloadUrl = await page
    .locator('code')
    .filter({ hasText: '/api/v1/webhooks/github/' })
    .innerText();
  const secret = await page
    .locator('code')
    .filter({ hasText: /^[0-9a-f]{64}$/ })
    .innerText();
  expect(payloadUrl).toContain(ORIGIN);
  await page.getByRole('button', { name: 'I have saved the secret' }).click();
  await expect(page.getByText(secret)).toHaveCount(0);

  // ...and never again: after a reload the repository is listed, without any secret on the page.
  await page.reload();
  const connected = page.getByRole('list', { name: 'Connected repositories' });
  await expect(connected.getByText('acme/storefront')).toBeVisible();
  await expect(connected.getByText('No deliveries received yet')).toBeVisible();
  await expect(page.getByText(secret)).toHaveCount(0);

  // Deliver webhooks exactly as GitHub would: to the public URL, signed, with no cookie or Origin.
  // This goes through the web app's proxy, so it also proves the headers and raw body survive it.
  const deployedAt = new Date(Date.now() - 10 * 60_000).toISOString();
  const event = {
    action: 'created',
    deployment_status: {
      state: 'success',
      created_at: new Date(Date.now() - 9 * 60_000).toISOString(),
      description: 'Deployment finished successfully.',
    },
    deployment: {
      id: 987654,
      sha: SHA,
      ref: 'main',
      environment: 'production',
      created_at: deployedAt,
      creator: { login: 'octocat' },
    },
    repository: { full_name: 'acme/storefront' },
  };
  const raw = JSON.stringify(event);
  const deliver = (signature: string, delivery = randomUUID()) =>
    request.post(payloadUrl, {
      data: raw,
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Event': 'deployment_status',
        'X-GitHub-Delivery': delivery,
        'X-Hub-Signature-256': signature,
      },
    });

  const forged = await deliver(sign('not-the-secret', raw));
  expect(forged.status()).toBe(401);
  const delivery = randomUUID();
  const accepted = await deliver(sign(secret, raw), delivery);
  expect(accepted.status()).toBe(202);
  expect(await accepted.json()).toEqual({ status: 'accepted' });
  const again = await deliver(sign(secret, raw), delivery);
  expect(await again.json()).toEqual({ status: 'duplicate' });

  // The worker turns it into a deployment, visible org-wide and on the service.
  await page.goto(`/orgs/${orgId}/deployments`);
  const table = page.getByRole('table', { name: 'Deployments' });
  await eventually(page, async () => {
    await expect(table.getByText('acme/storefront@abcdef1')).toBeVisible({ timeout: 1500 });
  });
  await expect(table.getByText('Succeeded')).toBeVisible();
  await expect(table.getByText('octocat')).toBeVisible();
  expect(await table.getByRole('row').count()).toBe(2); // header + one deployment, not two

  await page.goto(`/orgs/${orgId}/services/${service.id}`);
  await expect(
    page.getByRole('region', { name: 'Deployments' }).getByText('acme/storefront@abcdef1'),
  ).toBeVisible();

  // The connection now shows when GitHub last delivered.
  await page.goto(`/orgs/${orgId}/integrations`);
  await expect(page.getByText(/Last delivery/)).toBeVisible();

  // An incident opens on that service after the deployment: the deployment is suggested as a cause.
  const incident = await (
    await page.request.post(`/api/v1/orgs/${orgId}/incidents`, {
      data: { title: 'Checkout is failing', severity: 'SEV2', serviceId: service.id },
      headers,
    })
  ).json();
  await page.goto(`/orgs/${orgId}/incidents/${incident.id}`);
  const suggested = page.getByRole('list', { name: 'Suggested deployments' });
  await expect(suggested.getByText('acme/storefront@abcdef1')).toBeVisible();
  await suggested.getByRole('button', { name: 'Confirm as cause' }).click();

  const linked = page.getByRole('list', { name: 'Linked deployments' });
  await expect(linked.getByText('acme/storefront@abcdef1')).toBeVisible();
  await expect(linked.getByText('Confirmed cause')).toBeVisible();
  await expect(page.getByRole('list', { name: 'Suggested deployments' })).toHaveCount(0);
  const timeline = page.getByRole('list', { name: 'Incident timeline' });
  await expect(
    timeline.getByText('confirmed deployment abcdef1 to production as the cause'),
  ).toBeVisible();

  // Disconnecting stops deliveries but keeps history.
  await page.goto(`/orgs/${orgId}/integrations`);
  await page.getByRole('button', { name: 'Disconnect' }).click();
  await page.getByRole('button', { name: 'Disconnect' }).last().click();
  await expect(page.getByText('No repositories connected')).toBeVisible();
  expect((await deliver(sign(secret, raw), randomUUID())).status()).toBe(404);
  await page.goto(`/orgs/${orgId}/deployments`);
  await expect(
    page.getByRole('table', { name: 'Deployments' }).getByText('acme/storefront@abcdef1'),
  ).toBeVisible();
});
