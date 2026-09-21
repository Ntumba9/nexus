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

const nav = (page: Page, name: string) =>
  page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name, exact: true });

const RUNBOOK = [
  '# Restart the checkout service',
  'Use the deploy tool, then **watch the error rate** for ten minutes.',
  '',
  '## Steps',
  '1. Drain traffic from the load balancer',
  '2. Run `deploy restart checkout`',
  '',
  'See the [status page](https://status.example.com) and [bad](javascript:window.__pwned=1).',
  '',
  '<script>window.__pwned = 1</script>',
].join('\n');

test('write a runbook, search it, see it suggested on an incident, edit it, delete it', async ({
  page,
}) => {
  await signUp(page, 'Katherine Johnson', `e2e-${unique()}@example.com`);
  await page.getByLabel('Organization name').fill(`Knowledge Org ${unique()}`);
  await page.getByRole('button', { name: 'Create organization' }).click();
  await expect(page).toHaveURL(/\/orgs\/[0-9a-f-]{36}$/);
  const orgId = new URL(page.url()).pathname.split('/').pop()!;

  // Empty state first.
  await nav(page, 'Knowledge').click();
  await expect(page.getByText('No documents yet')).toBeVisible();

  // Write a document, with a preview before saving.
  await page.getByRole('link', { name: 'Write the first document' }).click();
  await page.getByLabel('Title', { exact: true }).fill('Checkout service restart runbook');
  await page.getByLabel('Tags').fill('checkout, runbook');
  await page.getByLabel('Content').fill(RUNBOOK);
  await page.getByRole('button', { name: 'preview' }).click();
  await expect(page.getByLabel('Preview').getByRole('heading', { name: 'Steps' })).toBeVisible();
  await page.getByRole('button', { name: 'Create document' }).click();

  // The rendered document: structure is shown, hostile content is inert.
  await expect(page).toHaveURL(/\/knowledge\/[0-9a-f-]{36}$/);
  await expect(
    page.getByRole('heading', { level: 1, name: 'Checkout service restart runbook' }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { level: 2, name: 'Restart the checkout service' }),
  ).toBeVisible();
  await expect(page.getByRole('listitem').filter({ hasText: 'Drain traffic' })).toBeVisible();
  await expect(page.locator('code', { hasText: 'deploy restart checkout' })).toBeVisible();
  const statusLink = page.getByRole('link', { name: 'status page' });
  await expect(statusLink).toHaveAttribute('href', 'https://status.example.com');
  await expect(statusLink).toHaveAttribute('rel', /noopener/);
  await expect(page.getByRole('link', { name: 'bad' })).toHaveCount(0); // javascript: link dropped
  await expect(page.getByText('<script>window.__pwned = 1</script>')).toBeVisible(); // shown as text
  expect(
    await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned),
  ).toBeUndefined();

  // Search by a question. Keyword search answers at once.
  await nav(page, 'Knowledge').click();
  await page.getByLabel('Search the knowledge base').fill('how do I restart checkout?');
  const results = page.getByRole('list', { name: 'Search results' });
  await expect(
    results.getByRole('link', { name: /Checkout service restart runbook/ }),
  ).toBeVisible();
  await expect(results.locator('mark').first()).toBeVisible(); // query words highlighted

  // The real worker embeds the chunks through the queue, so meaning-based search joins in.
  await expect
    .poll(
      async () => {
        const res = await page.request.get(
          `${ORIGIN}/api/v1/orgs/${orgId}/knowledge/search?q=${encodeURIComponent('restart checkout')}`,
        );
        const body = (await res.json()) as { data: { matchedBy: string[] }[] };
        return body.data[0]?.matchedBy.includes('semantic') ?? false;
      },
      { timeout: 20_000, message: 'the worker never embedded the document' },
    )
    .toBe(true);

  // An incident about the same thing gets the runbook suggested.
  const created = await page.request.post(`${ORIGIN}/api/v1/orgs/${orgId}/incidents`, {
    headers: { Origin: ORIGIN },
    data: { title: 'Checkout errors after deploy', severity: 'SEV2' },
  });
  expect(created.status()).toBe(201);
  const incident = (await created.json()) as { id: string };
  await page.goto(`/orgs/${orgId}/incidents/${incident.id}`);
  const related = page.getByRole('list', { name: 'Related runbooks' });
  await expect(
    related.getByRole('link', { name: 'Checkout service restart runbook' }),
  ).toBeVisible();
  await related.getByRole('link', { name: 'Checkout service restart runbook' }).click();
  await expect(page).toHaveURL(/\/knowledge\/[0-9a-f-]{36}$/);

  // Edit it.
  await page.getByRole('link', { name: 'Edit' }).click();
  await page.getByLabel('Title', { exact: true }).fill('Checkout restart (v2)');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(
    page.getByRole('heading', { level: 1, name: 'Checkout restart (v2)' }),
  ).toBeVisible();

  // Delete it, with a confirmation step.
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await page.getByRole('button', { name: 'Delete for good' }).click();
  await expect(page).toHaveURL(/\/knowledge$/);
  await expect(page.getByText('No documents yet')).toBeVisible();
});

test('a viewer can read and search but is not offered writing', async ({ page, browser }) => {
  await signUp(page, 'Owner Person', `e2e-${unique()}@example.com`);
  await page.getByLabel('Organization name').fill(`Viewer KB Org ${unique()}`);
  await page.getByRole('button', { name: 'Create organization' }).click();
  await expect(page).toHaveURL(/\/orgs\/[0-9a-f-]{36}$/);
  const orgId = new URL(page.url()).pathname.split('/').pop()!;
  const made = await page.request.post(`${ORIGIN}/api/v1/orgs/${orgId}/knowledge`, {
    headers: { Origin: ORIGIN },
    data: { title: 'Read-only runbook', contentMd: '# Hello\nSomething to read.', tags: [] },
  });
  expect(made.status()).toBe(201);

  // A second account is added as a VIEWER through the members API.
  const viewerEmail = `e2e-viewer-${unique()}@example.com`;
  const viewerContext = await browser.newContext();
  const viewerPage = await viewerContext.newPage();
  await signUp(viewerPage, 'Viewer Person', viewerEmail);
  const added = await page.request.post(`${ORIGIN}/api/v1/orgs/${orgId}/members`, {
    headers: { Origin: ORIGIN },
    data: { email: viewerEmail, role: 'VIEWER' },
  });
  expect(added.status()).toBeLessThan(300);

  await viewerPage.goto(`/orgs/${orgId}/knowledge`);
  await expect(viewerPage.getByRole('link', { name: 'Read-only runbook' })).toBeVisible();
  await expect(viewerPage.getByRole('link', { name: 'New document' })).toHaveCount(0);
  await viewerPage.getByRole('link', { name: 'Read-only runbook' }).click();
  await expect(
    viewerPage.getByRole('heading', { level: 1, name: 'Read-only runbook' }),
  ).toBeVisible();
  await expect(viewerPage.getByRole('link', { name: 'Edit' })).toHaveCount(0);
  await expect(viewerPage.getByRole('button', { name: 'Delete', exact: true })).toHaveCount(0);

  // Even by URL, the writing pages refuse, and so does the API.
  await viewerPage.goto(`/orgs/${orgId}/knowledge/new`);
  await expect(
    viewerPage.getByText('You can read the knowledge base, not write to it'),
  ).toBeVisible();
  const refused = await viewerPage.request.post(`${ORIGIN}/api/v1/orgs/${orgId}/knowledge`, {
    headers: { Origin: ORIGIN },
    data: { title: 'Nope', contentMd: '' },
  });
  expect(refused.status()).toBe(403);
  await viewerContext.close();
});
