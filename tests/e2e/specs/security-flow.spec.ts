import { expect, test, type Page } from '@playwright/test';

const PASSWORD = 'correct horse battery staple';
const NEW_PASSWORD = 'an entirely different passphrase 7';
const unique = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

async function signUp(page: Page, name: string, email: string): Promise<void> {
  await page.goto('/register');
  await page.getByLabel('Name', { exact: true }).fill(name);
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL(/\/onboarding$/);
}

async function createOrg(page: Page, name: string): Promise<string> {
  await page.getByLabel('Organization name').fill(name);
  await page.getByRole('button', { name: 'Create organization' }).click();
  await expect(page).toHaveURL(/\/orgs\/[0-9a-f-]{36}$/);
  return new URL(page.url()).pathname.split('/').pop()!;
}

test('every page carries a strict, per-request CSP, nothing legitimate is blocked, and injected script is', async ({
  page,
}) => {
  const violations: string[] = [];
  page.on('console', (message) => {
    if (/content security policy/i.test(message.text())) violations.push(message.text());
  });

  // Headers on a page response.
  const first = await page.goto('/login');
  const csp = first!.headers()['content-security-policy']!;
  expect(csp).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/=]+' 'strict-dynamic'/);
  expect(csp).toContain("frame-ancestors 'none'");
  expect(csp).toContain("object-src 'none'");
  expect(csp).toContain("default-src 'self'");
  expect(csp).not.toMatch(/unsafe-inline|unsafe-eval/);
  expect(first!.headers()['x-frame-options']).toBe('DENY');
  expect(first!.headers()['x-content-type-options']).toBe('nosniff');
  expect(first!.headers()['cross-origin-opener-policy']).toBe('same-origin');
  // Plain HTTP (localhost): no HSTS, and no upgrade of requests that would break local use.
  expect(first!.headers()['strict-transport-security']).toBeUndefined();
  expect(csp).not.toContain('upgrade-insecure-requests');

  // A fresh nonce on every request.
  const second = await page.goto('/login');
  const nonceOf = (value: string) => /'nonce-([^']+)'/.exec(value)![1];
  expect(nonceOf(second!.headers()['content-security-policy']!)).not.toBe(nonceOf(csp));

  // The real app works under it: sign up, and visit the main pages.
  await signUp(page, 'Policy Tester', `e2e-${unique()}@example.com`);
  const orgId = await createOrg(page, `CSP Org ${unique()}`);
  for (const path of [
    '',
    '/incidents',
    '/services',
    '/projects',
    '/knowledge',
    '/settings',
    '/deployments',
  ]) {
    await page.goto(`/orgs/${orgId}${path}`);
    await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
  }
  expect(violations, violations.join('\n')).toEqual([]);

  // Probe with things the policy forbids, and see whether the browser reports and refuses them.
  await page.addInitScript(() => {
    (window as unknown as { __violations: string[] }).__violations = [];
    document.addEventListener('securitypolicyviolation', (event) =>
      (window as unknown as { __violations: string[] }).__violations.push(event.violatedDirective),
    );
  });
  await page.goto(page.url());
  const probe = await page.evaluate(async () => {
    const results: Record<string, unknown> = {};
    // 1. A request to another origin (connect-src 'self').
    try {
      await fetch('https://example.org/');
      results.crossOriginFetch = 'allowed';
    } catch {
      results.crossOriginFetch = 'blocked';
    }
    // 2. An inline event handler (no script-src-attr / unsafe-inline).
    const img = document.createElement('img');
    img.setAttribute('onerror', 'window.__handlerRan = true');
    img.src = 'data:,';
    document.body.append(img);
    await new Promise((r) => setTimeout(r, 500));
    results.inlineHandlerRan =
      (window as unknown as { __handlerRan?: boolean }).__handlerRan === true;
    results.violations = (window as unknown as { __violations: string[] }).__violations;
    return results;
  });
  // The browser refused all three and said so. (Code run through Playwright's own evaluate is exempt
  // from CSP, so the probes are things the page itself tries to do, not scripts evaluated by the test.)
  expect(probe.crossOriginFetch).toBe('blocked');
  expect(probe.inlineHandlerRan).toBe(false);
  expect(probe.violations).toEqual(expect.arrayContaining(['connect-src', 'script-src-attr']));
});

test('forgot password gives the same answer for any address, and a bad reset link is refused', async ({
  page,
  browser,
}) => {
  const email = `e2e-${unique()}@example.com`;
  const other = await browser.newContext();
  const otherPage = await other.newPage();
  await signUp(otherPage, 'Existing Person', email);
  await other.close();

  const answers: string[] = [];
  for (const address of [email, `nobody-${unique()}@example.com`]) {
    await page.goto('/forgot-password');
    await page.getByLabel('Email').fill(address);
    await page.getByRole('button', { name: 'Send reset link' }).click();
    const alert = page.getByRole('status');
    await expect(alert).toContainText('a link to reset the password is on its way');
    answers.push((await alert.innerText()).replace(address, '<address>'));
  }
  expect(answers[0]).toBe(answers[1]); // nothing tells an account from a non-account

  // A reset link that was never issued.
  await page.goto(`/reset-password?token=${'A'.repeat(43)}`);
  await page.getByLabel('New password', { exact: true }).fill(NEW_PASSWORD);
  await page.getByLabel('Confirm new password').fill(NEW_PASSWORD);
  await page.getByRole('button', { name: 'Set new password' }).click();
  await expect(
    page.getByRole('alert').filter({ hasText: 'invalid, has already been used, or has expired' }),
  ).toBeVisible();

  // No token at all.
  await page.goto('/reset-password');
  await expect(page.getByRole('alert').filter({ hasText: 'not valid' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Send me a new link' })).toBeVisible();

  // Reachable from the login page.
  await page.goto('/login');
  await page.getByRole('link', { name: 'Forgot your password?' }).click();
  await expect(page).toHaveURL(/\/forgot-password$/);
});

test('change your password and sign out everywhere from settings, and the account audit shows it', async ({
  page,
  browser,
}) => {
  const email = `e2e-${unique()}@example.com`;
  await signUp(page, 'Rotating Person', email);
  const orgId = await createOrg(page, `Security Org ${unique()}`);

  // A second device signed in as the same person.
  const deviceContext = await browser.newContext();
  const device = await deviceContext.newPage();
  await device.goto('/login');
  await device.getByLabel('Email').fill(email);
  await device.getByLabel('Password').fill(PASSWORD);
  await device.getByRole('button', { name: 'Log in' }).click();
  await expect(device).toHaveURL(/\/onboarding$|\/orgs\//);

  await page.goto(`/orgs/${orgId}/settings`);
  const form = page.getByRole('form', { name: 'Change password' });

  // A wrong current password is refused and nothing changes.
  await form.getByLabel('Current password').fill('not my password at all');
  await form.getByLabel('New password', { exact: true }).fill(NEW_PASSWORD);
  await form.getByLabel('Confirm new password').fill(NEW_PASSWORD);
  await form.getByRole('button', { name: 'Change password' }).click();
  await expect(
    page.getByRole('alert').filter({ hasText: 'current password is not correct' }),
  ).toBeVisible();

  // The right one changes it, keeps this browser signed in and signs the other device out.
  await form.getByLabel('Current password').fill(PASSWORD);
  await form.getByRole('button', { name: 'Change password' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Password changed' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Organization settings' })).toBeVisible();
  await device.goto(`/orgs/${orgId}/settings`);
  await expect(device).toHaveURL(/\/login/);
  await deviceContext.close();

  // Sign out everywhere, with a confirmation step.
  await page.getByRole('button', { name: 'Sign out everywhere' }).click();
  await page.getByRole('button', { name: 'Yes, sign me out everywhere' }).click();
  await expect(page).toHaveURL(/\/login/);

  // The old password no longer works; the new one does; and the organization's audit log has the story.
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(
    page.getByRole('alert').filter({ hasText: 'Invalid email or password' }),
  ).toBeVisible();
  await page.getByLabel('Password').fill(NEW_PASSWORD);
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page).toHaveURL(/\/orgs\//);

  await page.goto(`/orgs/${orgId}/audit-log`);
  const text = await page.getByRole('main').innerText();
  for (const phrase of ['changed their password', 'signed out of every session', 'signed in']) {
    expect(text, phrase).toContain(phrase);
  }
  expect(text).not.toContain(NEW_PASSWORD);
  expect(text).not.toContain(PASSWORD);
});
