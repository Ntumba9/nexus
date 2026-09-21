// Fills a running NEXUS with a realistic demo organization, through the public API (so every rule,
// permission and audit entry applies exactly as it does for a real user).
//
//   pnpm demo                      # against http://localhost:3001 (the API) with origin http://localhost:3000
//   API_URL=... WEB_ORIGIN=... pnpm demo --allow-remote
//
// It creates accounts with a KNOWN password, so it refuses to run against anything but localhost
// unless you pass --allow-remote (for a public demo, also set DEMO_PRIVATE_PASSWORD; see
// docs/hosted-demo.md). It is safe to run again: every step skips what already exists, so a run that stopped halfway resumes.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { RULE_TEMPLATES } = require('../packages/shared/dist');

const API_URL = (process.env.API_URL ?? 'http://localhost:3001').replace(/\/+$/, '');
const WEB_ORIGIN = process.env.WEB_ORIGIN ?? 'http://localhost:3000';
const BASE = `${API_URL}/api/v1`;
// The published login. On a public demo this is the ONLY password visitors ever see, so it belongs to
// the read-only viewer account.
const PASSWORD = process.env.DEMO_PASSWORD ?? 'demo-passphrase-2026';
// The other accounts (owner, developer, support) can change data. For a public demo, set this to a
// strong secret of your own so the published password does not open them. It defaults to PASSWORD,
// which is fine on a local machine.
const PRIVATE_PASSWORD = process.env.DEMO_PRIVATE_PASSWORD ?? PASSWORD;
const passwordFor = (person) => (person.role === 'VIEWER' ? PASSWORD : PRIVATE_PASSWORD);
const ORG_NAME = 'Northwind Platform';
// Where the demo accounts live. Change it to seed a second, separate demo.
const DOMAIN = process.env.DEMO_DOMAIN ?? 'demo.example.com';

const isLocal = ['localhost', '127.0.0.1', '[::1]'].includes(new URL(API_URL).hostname);
if (!isLocal && !process.argv.includes('--allow-remote')) {
  console.error(
    `Refusing to seed ${API_URL}: the demo creates accounts with a known password.\n` +
      'Pass --allow-remote if you really mean it (never on a real installation).',
  );
  process.exit(1);
}

/** One signed-in user: a tiny client that keeps its own session cookie. */
class Session {
  cookie = '';
  async call(method, path, body, { allow = [] } = {}) {
    const res = await fetch(BASE + path, {
      method,
      headers: {
        'content-type': 'application/json',
        origin: WEB_ORIGIN,
        ...(this.cookie ? { cookie: this.cookie } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = res.headers.getSetCookie?.() ?? [];
    const session = setCookie
      .map((c) => c.split(';')[0])
      .find((c) => c.startsWith('nexus_session='));
    if (session) this.cookie = session;
    const text = await res.text();
    const json = text ? JSON.parse(text) : null;
    if (!res.ok && !allow.includes(res.status)) {
      throw new Error(
        `${method} ${path} -> ${res.status} ${json?.error?.code ?? ''} ${json?.error?.message ?? ''}`,
      );
    }
    return { status: res.status, body: json };
  }
}

const PEOPLE = [
  { email: `dana@${DOMAIN}`, name: 'Dana Okafor', role: 'OWNER' },
  { email: `sam@${DOMAIN}`, name: 'Sam Rivera', role: 'DEVELOPER' },
  { email: `robin@${DOMAIN}`, name: 'Robin Chen', role: 'SUPPORT' },
  { email: `viewer@${DOMAIN}`, name: 'Vic Alvarez', role: 'VIEWER' },
];

const RUNBOOKS = [
  {
    title: 'Checkout latency runbook',
    tags: ['checkout', 'latency', 'sev2'],
    contentMd: `# Checkout latency

Use this when checkout p99 latency is above 2 seconds for more than five minutes.

## First checks

1. Open the checkout dashboard and compare p50 with p99. A gap means a slow dependency, not general load.
2. Check the payment provider status page.
3. Look at the last deployment to **checkout**: a deploy in the last hour is the most likely cause.

## Mitigation

- Roll back the last checkout deployment if it landed within an hour of the first alert.
- If the payment provider is degraded, enable the fallback queue: \`FEATURE_PAYMENT_QUEUE=on\`.
- Scale the checkout deployment to 6 replicas if CPU is above 80%.

## After

Write a short note on the incident: what you saw, what you did, and what you would change.
`,
  },
  {
    title: 'Database connection pool exhausted',
    tags: ['database', 'postgres', 'sev1'],
    contentMd: `# Database connection pool exhausted

Symptoms: the API returns 503, logs show "timeout acquiring a connection".

## Diagnose

- Run \`select state, count(*) from pg_stat_activity group by 1\`. Many **idle in transaction** sessions mean a leak.
- Find the longest-running transactions and who owns them.

## Fix

1. Terminate idle-in-transaction sessions older than 5 minutes.
2. Restart the API pods one at a time.
3. Raise the pool size only as a last resort: it hides the leak.

## Follow up

Open a ticket for the code path that held the transaction open.
`,
  },
  {
    title: 'Search index is stale',
    tags: ['search', 'indexing'],
    contentMd: `# Search index is stale

New products do not appear in search results.

- Check the indexer queue depth. A growing queue means the indexer is down.
- Restart the indexer, then trigger a full reindex from the admin page.
- A full reindex takes about 20 minutes and does not affect reads.
`,
  },
];

const INCIDENTS = [
  {
    title: 'Checkout latency above 4s for EU customers',
    severity: 'SEV2',
    service: 'checkout',
    tags: ['latency', 'checkout'],
    description:
      'p99 checkout latency began climbing at 09:12 UTC. EU customers are most affected.',
    path: ['ACKNOWLEDGED', 'INVESTIGATING'],
    comments: ['Latency correlates with the 09:05 checkout deployment. Comparing traces now.'],
  },
  {
    title: 'API returning 503 to some requests',
    severity: 'SEV1',
    service: 'api-gateway',
    tags: ['database', 'api'],
    description:
      'A fraction of API requests fail with 503. The database connection pool looks exhausted.',
    path: ['ACKNOWLEDGED', 'INVESTIGATING', 'MITIGATED'],
    comments: [
      'Idle-in-transaction sessions are piling up. Terminated the oldest ones.',
      'Error rate is back to normal after restarting the API pods.',
    ],
  },
  {
    title: 'New products missing from search',
    severity: 'SEV3',
    service: 'search',
    tags: ['search'],
    description: 'Products added since yesterday do not show up in search.',
    path: ['ACKNOWLEDGED', 'INVESTIGATING', 'RESOLVED'],
    comments: ['The indexer was stuck. Restarted it and ran a full reindex.'],
  },
  {
    title: 'Staging deploys failing intermittently',
    severity: 'SEV4',
    service: 'checkout-staging',
    tags: ['ci'],
    description: 'About one in five staging deploys fails on the migration step.',
    path: [],
    comments: [],
  },
];

const rows = (body) => (Array.isArray(body) ? body : (body?.data ?? []));

async function main() {
  console.log(`Seeding ${API_URL} (origin ${WEB_ORIGIN})\n`);
  console.log(
    'Each step skips what already exists, so a run that stopped halfway can be repeated.\n',
  );

  // 1. Accounts. Sign in first and register only if that fails, so repeating the run does not
  // spend the (deliberately strict) registration rate limit on accounts that already exist.
  const sessions = {};
  for (const person of PEOPLE) {
    const s = new Session();
    const login = await s.call(
      'POST',
      '/auth/login',
      { email: person.email, password: passwordFor(person) },
      { allow: [401] },
    );
    if (login.status === 401) {
      await s.call('POST', '/auth/register', {
        email: person.email,
        name: person.name,
        password: passwordFor(person),
      });
    }
    sessions[person.email] = s;
    console.log(
      `  account   ${person.name} <${person.email}>${login.status === 401 ? '' : ' (existing)'}`,
    );
  }
  const dana = sessions[PEOPLE[0].email];
  const sam = sessions[PEOPLE[1].email];

  // 2. Organization and members.
  const orgs = rows((await dana.call('GET', '/orgs')).body);
  let org = orgs.find((o) => o.name === ORG_NAME);
  if (!org) org = (await dana.call('POST', '/orgs', { name: ORG_NAME })).body;
  // The list calls it organizationId; a freshly created organization may say id.
  const orgPath = `/orgs/${org.organizationId ?? org.id}`;
  const members = rows((await dana.call('GET', `${orgPath}/members`)).body);
  for (const person of PEOPLE.slice(1)) {
    if (members.some((m) => m.email === person.email)) continue;
    await dana.call('POST', `${orgPath}/members`, { email: person.email, role: person.role });
  }
  console.log(`  org       ${ORG_NAME} with ${PEOPLE.length} members`);

  // 3. Automation first, so the incidents below trigger real notifications.
  const rules = rows((await dana.call('GET', `${orgPath}/automation/rules`)).body);
  let created = 0;
  for (const id of ['critical-incident-alert', 'service-down']) {
    const template = RULE_TEMPLATES.find((t) => t.id === id);
    if (rules.some((r) => r.name === template.rule.name)) continue;
    await dana.call('POST', `${orgPath}/automation/rules`, template.rule);
    created++;
  }
  console.log(`  rules     2 automation rules from templates (${created} new)`);

  // 4. Project, services and (best effort) a health check.
  let project = rows((await dana.call('GET', `${orgPath}/projects`)).body).find(
    (p) => p.name === 'Storefront',
  );
  if (!project) {
    project = (
      await dana.call('POST', `${orgPath}/projects`, {
        name: 'Storefront',
        description: 'The customer-facing shop: API, checkout and search.',
      })
    ).body;
  }
  const existing = rows(
    (await dana.call('GET', `${orgPath}/services?projectId=${project.id}`)).body,
  );
  const services = Object.fromEntries(existing.map((svc) => [svc.name, svc]));
  for (const [name, environment] of [
    ['api-gateway', 'PRODUCTION'],
    ['checkout', 'PRODUCTION'],
    ['search', 'PRODUCTION'],
    ['checkout-staging', 'STAGING'],
  ]) {
    if (services[name]) continue;
    services[name] = (
      await dana.call('POST', `${orgPath}/projects/${project.id}/services`, { name, environment })
    ).body;
  }
  console.log(`  project   Storefront with ${Object.keys(services).length} services`);

  const checksPath = `${orgPath}/services/${services['api-gateway'].id}/checks`;
  const checks = rows((await dana.call('GET', checksPath)).body);
  if (checks.length > 0) {
    console.log('  check     1 HTTP health check (existing)');
  } else {
    // It probes a public site, so it needs internet, and is skipped if the API refuses the URL.
    const check = await dana.call(
      'POST',
      checksPath,
      { name: 'Home page', url: 'https://example.com', expectedStatus: 200, intervalSeconds: 60 },
      { allow: [400, 409] },
    );
    console.log(
      check.status < 300
        ? '  check     1 HTTP health check'
        : '  check     skipped (URL not allowed)',
    );
  }

  // 5. Runbooks.
  const docs = rows((await dana.call('GET', `${orgPath}/knowledge`)).body);
  for (const doc of RUNBOOKS) {
    if (docs.some((d) => d.title === doc.title)) continue;
    await dana.call('POST', `${orgPath}/knowledge`, doc);
  }
  console.log(`  runbooks  ${RUNBOOKS.length}`);

  // 6. Incidents at different stages, opened by different people.
  const incidents = rows((await dana.call('GET', `${orgPath}/incidents?limit=100`)).body);
  for (const [i, spec] of INCIDENTS.entries()) {
    if (incidents.some((inc) => inc.title === spec.title)) continue;
    const author = i % 2 === 0 ? dana : sam;
    const incident = (
      await author.call('POST', `${orgPath}/incidents`, {
        title: spec.title,
        severity: spec.severity,
        description: spec.description,
        serviceId: services[spec.service].id,
        tags: spec.tags,
      })
    ).body;
    for (const to of spec.path) {
      await dana.call('POST', `${orgPath}/incidents/${incident.id}/transitions`, { to });
    }
    for (const body of spec.comments) {
      await dana.call('POST', `${orgPath}/incidents/${incident.id}/comments`, { body });
    }
  }
  console.log(`  incidents ${INCIDENTS.length} (open, investigating, mitigated and resolved)`);

  // 7. AI investigations on the two headline incidents. Only people who can edit incidents can start
  // one, so a read-only visitor would otherwise never see this feature. They run on the worker; if it
  // is not running they stay queued and finish when it starts.
  const allIncidents = rows((await dana.call('GET', `${orgPath}/incidents?limit=100`)).body);
  const results = [];
  for (const spec of INCIDENTS.slice(0, 2)) {
    const incident = allIncidents.find((inc) => inc.title === spec.title);
    const path = `${orgPath}/incidents/${incident.id}/investigations`;
    let list = rows((await dana.call('GET', path)).body);
    if (list.length === 0) {
      await dana.call('POST', path, {});
      for (let i = 0; i < 20; i++) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        list = rows((await dana.call('GET', path)).body);
        if (list.some((inv) => inv.status === 'SUCCEEDED' || inv.status === 'FAILED')) break;
      }
    }
    results.push(list[0]?.status ?? 'none');
  }
  console.log(`  ai        investigations: ${results.join(', ')}`);
  if (results.some((status) => status === 'QUEUED' || status === 'RUNNING')) {
    console.log('            (still running: they finish once the worker has processed them)');
  }

  const viewer = PEOPLE.find((person) => person.role === 'VIEWER');
  const split = PRIVATE_PASSWORD !== PASSWORD;
  console.log('');
  console.log('Done. Open ' + WEB_ORIGIN + ' and sign in as:');
  console.log(
    '  owner   ' + PEOPLE[0].email + '   ' + (split ? '(your DEMO_PRIVATE_PASSWORD)' : PASSWORD),
  );
  console.log('  viewer  ' + viewer.email + '   ' + PASSWORD + '   (read-only)');
  if (split) {
    console.log(
      'Only the viewer login is safe to publish. The owner, developer and support accounts use your private password.',
    );
  } else {
    console.log('All accounts share one password. That is fine locally; never publish it.');
  }
}

main().catch((error) => {
  console.error(`\nDemo seeding failed: ${error.message}`);
  // Not process.exit(): on Windows it can abort while a socket is still closing.
  process.exitCode = 1;
});
