import { expect, test, type Page } from '@playwright/test';

const PASSWORD = 'correct horse battery staple';
const ORIGIN = process.env.E2E_BASE_URL ?? 'http://localhost:3000';
const unique = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

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

async function register(page: Page, name: string): Promise<string> {
  const email = `e2e-${unique()}@example.com`;
  await page.goto('/register');
  await page.getByLabel('Name', { exact: true }).fill(name);
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL(/\/onboarding$/);
  return email;
}

test('a rule made from a template notifies people, records what it did, and is audited', async ({
  page,
  browser,
}) => {
  test.setTimeout(180_000);

  // An organization with a project and a service (via the API: this test is about automation).
  await register(page, 'Automation Tester');
  await page.getByLabel('Organization name').fill(`Automation Org ${unique()}`);
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
  const openIncident = async (title: string, severity: string) =>
    (
      await (
        await page.request.post(`/api/v1/orgs/${orgId}/incidents`, {
          data: { title, severity, serviceId: service.id },
          headers,
        })
      ).json()
    ).id as string;

  // Nothing is set up yet.
  await page.goto(`/orgs/${orgId}/automations`);
  await expect(page.getByText('No automation rules yet')).toBeVisible();

  // Create a rule from a template, through the UI.
  await page.getByRole('button', { name: 'New rule' }).click();
  await page
    .getByLabel('Start from a template')
    .selectOption({ label: 'Alert admins to critical incidents' });
  await expect(page.getByLabel('Rule name')).toHaveValue('Critical incident alert');
  await expect(page.getByLabel('When this happens')).toHaveValue('incident.created');
  await page.getByLabel('Rule name').fill('E2E critical alert');
  await page.getByRole('button', { name: 'Save rule' }).click();

  const rules = page.getByRole('list', { name: 'Automation rules' });
  await expect(rules.getByText('E2E critical alert')).toBeVisible();
  await expect(rules.getByText('Has not run yet')).toBeVisible();
  await expect(rules.getByText('Severity is one of SEV-1, SEV-2')).toBeVisible();
  await expect(rules.getByText('Notify owners, admins (in-app, email)')).toBeVisible();

  // A critical incident opens: the worker matches the rule and notifies the owner (this user).
  const incidentId = await openIncident('Checkout is down', 'SEV1');
  await page.goto(`/orgs/${orgId}`);
  const bell = page.getByRole('button', { name: /^Notifications, 1 unread$/ });
  await eventually(page, async () => {
    await expect(bell).toBeVisible({ timeout: 1500 });
  });

  await bell.click();
  const item = page.getByRole('link', { name: /SEV1 incident INC-\d+: Checkout is down/ });
  await expect(item).toBeVisible();
  await item.click();
  await expect(page).toHaveURL(new RegExp(`/incidents/${incidentId}$`));

  // The incident's timeline says an automation ran, and who did it.
  const timeline = page.getByRole('list', { name: 'Incident timeline' });
  await expect(timeline.getByText('ran the automation rule “E2E critical alert”')).toBeVisible();
  await expect(timeline.getByText('Automation', { exact: true }).first()).toBeVisible();

  // Reading it cleared the badge.
  await expect(page.getByRole('button', { name: /^Notifications, \d+ unread$/ })).toHaveCount(0);

  // The rule shows what it did.
  await page.goto(`/orgs/${orgId}/automations`);
  await expect(rules.getByText(/Last ran .*Succeeded/)).toBeVisible();
  await rules.getByRole('button', { name: 'Show runs' }).click();
  const runs = page.getByRole('list', { name: 'Runs of E2E critical alert' });
  await expect(runs.getByText('Succeeded')).toBeVisible();
  // The owner is the only member, so exactly one person is told, in-app and by email.
  await expect(runs.getByText('notified: 1 in-app, 1 emailed')).toBeVisible();

  // An incident the rule does not match creates no run.
  await openIncident('Minor glitch', 'SEV4');
  await page.waitForTimeout(4000); // give the worker a few dispatch ticks
  await page.reload();
  await rules.getByRole('button', { name: 'Show runs' }).click();
  // One run (its own list of action results is nested inside it, so count direct children only).
  await expect(
    page.getByRole('list', { name: 'Runs of E2E critical alert' }).locator(':scope > li'),
  ).toHaveCount(1);

  // Turn the rule off: the next critical incident does nothing.
  await rules.getByRole('button', { name: 'Turn off' }).click();
  await expect(rules.getByText('Off', { exact: true })).toBeVisible();
  await openIncident('Another outage', 'SEV1');
  await page.waitForTimeout(4000);
  await page.goto(`/orgs/${orgId}/notifications`);
  const inbox = page.getByRole('list', { name: 'Notifications' });
  await expect(inbox.getByRole('listitem')).toHaveCount(1); // still only the first one
  await expect(page.getByText('0 unread')).toBeVisible();

  // The audit log records who changed the rule, and cannot be edited from the UI.
  await page.goto(`/orgs/${orgId}/audit-log`);
  const audit = page.getByRole('table', { name: 'Audit log' });
  await expect(audit.getByText('created the automation rule “E2E critical alert”')).toBeVisible();
  await expect(
    audit.getByText('turned off the automation rule “E2E critical alert”'),
  ).toBeVisible();
  await expect(audit.getByText('Automation Tester').first()).toBeVisible();
  await expect(page.getByRole('button', { name: /delete|edit/i })).toHaveCount(0);

  // Outbound webhooks: the signing secret is shown once and never again.
  await page.goto(`/orgs/${orgId}/integrations`);
  await page.getByLabel('Webhook name').fill('Pager');
  await page.getByLabel('Webhook URL').fill('https://hooks.example.com/nexus?token=SUPERSECRET');
  await page.getByRole('button', { name: 'Add webhook' }).click();
  await expect(page.getByText('“Pager” was added')).toBeVisible();
  const secret = await page
    .locator('code')
    .filter({ hasText: /^[0-9a-f]{64}$/ })
    .innerText();
  await page.getByRole('button', { name: 'I have saved the secret' }).click();
  await expect(page.getByText(secret)).toHaveCount(0);
  await page.reload();
  const hooks = page.getByRole('list', { name: 'Outbound webhooks' });
  await expect(hooks.getByText('Pager')).toBeVisible();
  await expect(hooks.getByText('https://hooks.example.com/nexus')).toBeVisible();
  await expect(page.getByText(secret)).toHaveCount(0);
  await expect(page.getByText('SUPERSECRET')).toHaveCount(0); // not even the query string

  // A viewer cannot manage automation or read the audit log, and sees only their own notifications.
  const viewerContext = await browser.newContext({ baseURL: ORIGIN });
  const viewer = await viewerContext.newPage();
  const viewerEmail = await register(viewer, 'Viewer Person');
  await viewer.getByLabel('Organization name').fill(`Viewer Own Org ${unique()}`);
  await viewer.getByRole('button', { name: 'Create organization' }).click();
  await expect(viewer).toHaveURL(/\/orgs\/[0-9a-f-]{36}$/);
  const added = await page.request.post(`/api/v1/orgs/${orgId}/members`, {
    data: { email: viewerEmail, role: 'VIEWER' },
    headers,
  });
  expect(added.status()).toBe(201);
  await viewer.goto(`/orgs/${orgId}/automations`);
  await expect(viewer.getByText('Administrators manage automations')).toBeVisible();
  await expect(viewer.getByRole('link', { name: 'Automations' })).toHaveCount(0);
  await viewer.goto(`/orgs/${orgId}/audit-log`);
  await expect(viewer.getByText('Administrators can read the audit log')).toBeVisible();
  expect((await viewer.request.get(`/api/v1/orgs/${orgId}/automation/rules`)).status()).toBe(403);
  expect((await viewer.request.get(`/api/v1/orgs/${orgId}/audit-logs`)).status()).toBe(403);
  await viewer.goto(`/orgs/${orgId}/notifications`);
  await expect(viewer.getByText('No notifications yet')).toBeVisible(); // not the owner's
  await viewerContext.close();
});
