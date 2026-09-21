import { QUEUE_NAMES, type EmbedDocumentPayload } from '@nexus/shared';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import {
  HAS_INFRA,
  createOrg,
  createTestApp,
  registerUser,
  type TestApp,
  type TestUser,
} from '../testing/harness';

const TOKEN = 'metrics-token-0123456789abcdef';
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

describe.skipIf(!HAS_INFRA)('metrics and request correlation (integration)', () => {
  let t: TestApp;
  let owner: TestUser;
  let orgId: string;

  beforeAll(async () => {
    t = await createTestApp({ env: { METRICS_TOKEN: TOKEN } });
    owner = await registerUser(t, 'Observed Owner');
    orgId = (await createOrg(owner, 'Observed Org')).id;
  });
  afterAll(() => t.close());

  function scrapeWith(header?: string) {
    const req = request(t.server).get('/metrics');
    if (header) req.set('Authorization', header);
    return req;
  }

  it('needs the bearer token, and refuses a wrong, missing or malformed one', async () => {
    for (const header of [
      undefined,
      'Bearer nope',
      `Basic ${TOKEN}`,
      `Bearer ${TOKEN}x`,
      `bearer ${TOKEN}`,
      'Bearer ',
    ]) {
      const res = await scrapeWith(header);
      expect(res.status, String(header)).toBe(401);
      expect(res.text).not.toContain('nexus_http');
    }
    // A session cookie is not a substitute for the token.
    const withCookie = await request(t.server)
      .get('/metrics')
      .set('Cookie', owner.client.cookie ?? '');
    expect(withCookie.status).toBe(401);
  });

  it('serves Prometheus text with request counts by route TEMPLATE, never a URL with ids', async () => {
    const project = await owner.client.post(`/orgs/${orgId}/projects`, { name: 'Metered' });
    await owner.client.get(`/orgs/${orgId}/projects/${project.body.id}`);
    await owner.client.get(`/orgs/${orgId}/projects/${project.body.id}`);
    await owner.client.get('/does/not/exist');

    const res = await scrapeWith(`Bearer ${TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.headers['cache-control']).toBe('no-store');

    expect(res.text).toContain('# TYPE nexus_http_requests_total counter');
    expect(res.text).toMatch(
      /nexus_http_requests_total\{method="GET",route="\/api\/v1\/orgs\/:orgId\/projects\/:projectId",status="2xx"\} \d+/,
    );
    expect(res.text).toMatch(
      /nexus_http_requests_total\{method="POST",route="\/api\/v1\/orgs\/:orgId\/projects",status="2xx"\} \d+/,
    );
    expect(res.text).toMatch(/route="unmatched",status="4xx"/); // scanners are one series, not thousands
    expect(res.text).toContain('nexus_http_request_duration_seconds_bucket');
    expect(res.text).toContain('nexus_http_request_duration_seconds_count');
    expect(res.text).toMatch(/nexus_realtime_connections \d+/);
    expect(res.text).toMatch(/nexus_process_uptime_seconds [\d.]+/);

    // Nothing about who or what: no ids, no emails, no organization names.
    expect(res.text).not.toMatch(UUID);
    expect(res.text).not.toContain(owner.email);
    expect(res.text).not.toContain('Observed Org');
  });

  it('does not count its own scrapes or the health probes', async () => {
    for (let i = 0; i < 3; i += 1) {
      await scrapeWith(`Bearer ${TOKEN}`);
      await owner.client.get('/health/live');
    }
    const text = (await scrapeWith(`Bearer ${TOKEN}`)).text;
    expect(text).not.toMatch(/route="\/metrics"/);
    expect(text).not.toMatch(/route="\/health/);
  });

  it('writes the request id into the queue job it caused, so a worker log line links back to the request', async () => {
    const redis = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: null });
    const queue = new Queue(QUEUE_NAMES.knowledge, { connection: redis });
    try {
      const res = await owner.client.post(`/orgs/${orgId}/knowledge`, {
        title: 'Correlated',
        contentMd: '# Hi\nSome text.',
      });
      expect(res.status).toBe(201);
      const requestId = res.headers['x-request-id'] as string;
      const jobs = await queue.getJobs([
        'waiting',
        'delayed',
        'active',
        'prioritized',
        'completed',
      ]);
      const job = jobs.find((j) => (j.data as EmbedDocumentPayload).documentId === res.body.id);
      expect(job, 'the embed job').toBeTruthy();
      expect((job!.data as EmbedDocumentPayload).requestId).toBe(requestId);
    } finally {
      await queue.close();
      await redis.quit();
    }
  });
});

describe.skipIf(!HAS_INFRA)('metrics endpoint, not configured (integration)', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp({ env: { METRICS_TOKEN: '' } });
  });
  afterAll(() => t.close());

  it('does not exist without a token, whatever is presented', async () => {
    for (const header of [undefined, `Bearer ${TOKEN}`, 'Bearer ']) {
      const req = request(t.server).get('/metrics');
      if (header) req.set('Authorization', header);
      const res = await req;
      expect(res.status, String(header)).toBe(404);
    }
  });
});
