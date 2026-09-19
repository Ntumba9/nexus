import { randomInt, randomUUID } from 'node:crypto';
import type { PrismaClient } from '@nexus/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanupOldWebhookEvents } from '../monitoring/maintenance';
import { HAS_DB, seedService, testPrisma } from '../testing/db';
import { markWebhookEventFailed, processWebhookEvent } from './process-webhook';

const REPO = 'acme/storefront';
const at = (iso: string) => new Date(iso);

function statusEvent(
  over: {
    id?: number;
    state?: string;
    statusAt?: string;
    startedAt?: string;
    repo?: string;
    sha?: string;
  } = {},
) {
  return {
    action: 'created',
    deployment_status: {
      state: over.state ?? 'success',
      created_at: over.statusAt ?? '2026-09-20T10:05:00Z',
      description: `state ${over.state ?? 'success'}`,
    },
    deployment: {
      id: over.id ?? 1001,
      sha: over.sha ?? 'b'.repeat(40),
      ref: 'main',
      environment: 'production',
      created_at: over.startedAt ?? '2026-09-20T10:00:00Z',
      creator: { login: 'octocat' },
    },
    repository: { full_name: over.repo ?? REPO },
  };
}

describe.skipIf(!HAS_DB)('GitHub webhook processing (integration)', () => {
  let prisma: PrismaClient;
  beforeAll(() => {
    prisma = testPrisma();
  });
  afterAll(() => prisma.$disconnect());

  /** A fresh tenant with one integration; helpers to store events and process them. */
  async function tenant(withService = true) {
    const base = await seedService(prisma);
    const integration = await prisma.gitHubIntegration.create({
      data: {
        organizationId: base.organizationId,
        projectId: base.projectId,
        serviceId: withService ? base.serviceId : null,
        repoFullName: REPO,
        webhookSecretEncrypted: 'v1:not-used-by-the-worker',
      },
    });
    const store = (eventType: string, payload: unknown) =>
      prisma.webhookEvent.create({
        data: {
          organizationId: base.organizationId,
          integrationId: integration.id,
          deliveryId: randomUUID(),
          eventType,
          payload: payload as object,
        },
      });
    const run = async (eventType: string, payload: unknown) => {
      const event = await store(eventType, payload);
      const outcome = await processWebhookEvent(
        { prisma },
        { webhookEventId: event.id, organizationId: base.organizationId },
      );
      return { event, outcome };
    };
    const statusOf = async (id: string) =>
      (await prisma.webhookEvent.findUniqueOrThrow({ where: { id } })).status;
    return { ...base, integration, store, run, statusOf };
  }

  it('records a successful deployment against the integration project and service', async () => {
    const t = await tenant();
    const { event, outcome } = await t.run('deployment_status', statusEvent());
    expect(outcome.status).toBe('processed');
    const d = await prisma.deployment.findFirstOrThrow({
      where: { integrationId: t.integration.id },
    });
    expect(d).toMatchObject({
      organizationId: t.organizationId,
      projectId: t.projectId,
      serviceId: t.serviceId,
      externalId: '1001',
      environment: 'production',
      ref: 'main',
      status: 'SUCCESS',
      author: 'octocat',
      commitSha: 'b'.repeat(40),
    });
    expect(d.deployedAt?.toISOString()).toBe('2026-09-20T10:05:00.000Z');
    expect(d.startedAt.toISOString()).toBe('2026-09-20T10:00:00.000Z');
    expect(await t.statusOf(event.id)).toBe('PROCESSED');
  });

  it('attaches to the project only when the integration has no service', async () => {
    const t = await tenant(false);
    await t.run('deployment_status', statusEvent());
    const d = await prisma.deployment.findFirstOrThrow({
      where: { integrationId: t.integration.id },
    });
    expect(d.serviceId).toBeNull();
    expect(d.projectId).toBe(t.projectId);
  });

  it('follows a deployment through its statuses as one row', async () => {
    const t = await tenant();
    await t.run(
      'deployment_status',
      statusEvent({ state: 'queued', statusAt: '2026-09-20T10:00:10Z' }),
    );
    await t.run(
      'deployment_status',
      statusEvent({ state: 'in_progress', statusAt: '2026-09-20T10:01:00Z' }),
    );
    let d = await prisma.deployment.findFirstOrThrow({
      where: { integrationId: t.integration.id },
    });
    expect(d).toMatchObject({ status: 'IN_PROGRESS', deployedAt: null });

    await t.run(
      'deployment_status',
      statusEvent({ state: 'success', statusAt: '2026-09-20T10:05:00Z' }),
    );
    d = await prisma.deployment.findFirstOrThrow({ where: { integrationId: t.integration.id } });
    expect(d.status).toBe('SUCCESS');
    expect(d.deployedAt?.toISOString()).toBe('2026-09-20T10:05:00.000Z');

    // A later "inactive" (superseded) keeps the original ship time.
    await t.run(
      'deployment_status',
      statusEvent({ state: 'inactive', statusAt: '2026-09-20T11:00:00Z' }),
    );
    d = await prisma.deployment.findFirstOrThrow({ where: { integrationId: t.integration.id } });
    expect(d.status).toBe('INACTIVE');
    expect(d.deployedAt?.toISOString()).toBe('2026-09-20T10:05:00.000Z');
    expect(await prisma.deployment.count({ where: { integrationId: t.integration.id } })).toBe(1);
  });

  it('ignores a stale status that arrives after a newer one', async () => {
    const t = await tenant();
    await t.run(
      'deployment_status',
      statusEvent({ state: 'success', statusAt: '2026-09-20T10:05:00Z' }),
    );
    const late = await t.run(
      'deployment_status',
      statusEvent({ state: 'in_progress', statusAt: '2026-09-20T10:01:00Z' }),
    );
    expect(late.outcome.status).toBe('processed'); // handled, but it changes nothing
    const d = await prisma.deployment.findFirstOrThrow({
      where: { integrationId: t.integration.id },
    });
    expect(d.status).toBe('SUCCESS');
    expect(d.statusUpdatedAt.toISOString()).toBe('2026-09-20T10:05:00.000Z');
  });

  it('is idempotent: reprocessing the same event changes nothing and creates nothing', async () => {
    const t = await tenant();
    const { event } = await t.run('deployment_status', statusEvent());
    const payload = { webhookEventId: event.id, organizationId: t.organizationId };
    const again = await processWebhookEvent({ prisma }, payload);
    expect(again).toEqual({ status: 'skipped', reason: 'already PROCESSED' });
    expect(await prisma.deployment.count({ where: { integrationId: t.integration.id } })).toBe(1);
  });

  it('handles two events for one new deployment being processed at the same time', async () => {
    const t = await tenant();
    const [a, b] = await Promise.all([
      t.store(
        'deployment_status',
        statusEvent({ state: 'in_progress', statusAt: '2026-09-20T10:01:00Z' }),
      ),
      t.store(
        'deployment_status',
        statusEvent({ state: 'success', statusAt: '2026-09-20T10:05:00Z' }),
      ),
    ]);
    const results = await Promise.allSettled(
      [a, b].map((e) =>
        processWebhookEvent({ prisma }, { webhookEventId: e.id, organizationId: t.organizationId }),
      ),
    );
    // One may lose the race to insert; that is the transient error BullMQ retries. Retry it here.
    for (const [i, r] of results.entries()) {
      if (r.status === 'rejected') {
        await processWebhookEvent(
          { prisma },
          { webhookEventId: [a, b][i]!.id, organizationId: t.organizationId },
        );
      }
    }
    const rows = await prisma.deployment.findMany({ where: { integrationId: t.integration.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('SUCCESS');
    expect(await t.statusOf(a.id)).toBe('PROCESSED');
    expect(await t.statusOf(b.id)).toBe('PROCESSED');
  });

  it('marks malformed or unsupported payloads FAILED without retrying', async () => {
    const t = await tenant();
    for (const payload of [
      {},
      { repository: { full_name: REPO } },
      statusEvent({ state: 'exploded' }),
    ]) {
      const { event, outcome } = await t.run('deployment_status', payload);
      expect(outcome.status).toBe('failed');
      expect(await t.statusOf(event.id)).toBe('FAILED');
      expect(
        (await prisma.webhookEvent.findUniqueOrThrow({ where: { id: event.id } })).error,
      ).toBeTruthy();
    }
    expect(await prisma.deployment.count({ where: { integrationId: t.integration.id } })).toBe(0);
  });

  it('refuses an event about a different repository than the integration', async () => {
    const t = await tenant();
    const { event, outcome } = await t.run(
      'deployment_status',
      statusEvent({ repo: 'someone-else/other-repo' }),
    );
    expect(outcome).toEqual({
      status: 'failed',
      reason: 'event is for a different repository than the integration',
    });
    expect(await t.statusOf(event.id)).toBe('FAILED');
    expect(await prisma.deployment.count({ where: { integrationId: t.integration.id } })).toBe(0);
  });

  it('acknowledges ping and ignores other event types', async () => {
    const t = await tenant();
    const ping = await t.run('ping', { zen: 'hi' });
    expect(ping.outcome.status).toBe('processed');
    expect(await t.statusOf(ping.event.id)).toBe('PROCESSED');
    const other = await t.run('issues', { action: 'opened' });
    expect(other.outcome.status).toBe('ignored');
    expect(await t.statusOf(other.event.id)).toBe('IGNORED');
    expect(await prisma.deployment.count({ where: { integrationId: t.integration.id } })).toBe(0);
  });

  it('skips an event that does not exist or belongs to another organization', async () => {
    const a = await tenant();
    const b = await tenant();
    const event = await a.store('deployment_status', statusEvent());
    const wrongOrg = await processWebhookEvent(
      { prisma },
      { webhookEventId: event.id, organizationId: b.organizationId },
    );
    expect(wrongOrg.status).toBe('skipped');
    const missing = await processWebhookEvent(
      { prisma },
      { webhookEventId: randomUUID(), organizationId: a.organizationId },
    );
    expect(missing.status).toBe('skipped');
    expect(await a.statusOf(event.id)).toBe('RECEIVED'); // untouched
    expect(await prisma.deployment.count({ where: { organizationId: b.organizationId } })).toBe(0);
  });

  it('records exhausted retries on the event, and never overwrites a finished one', async () => {
    const t = await tenant();
    const stuck = await t.store('deployment_status', statusEvent({ id: randomInt(1, 9999) }));
    await markWebhookEventFailed(
      prisma,
      { webhookEventId: stuck.id, organizationId: t.organizationId },
      'db down',
    );
    expect(await t.statusOf(stuck.id)).toBe('FAILED');

    const done = await t.run('ping', {});
    await markWebhookEventFailed(
      prisma,
      { webhookEventId: done.event.id, organizationId: t.organizationId },
      'late',
    );
    expect(await t.statusOf(done.event.id)).toBe('PROCESSED');
  });

  it('deletes only old webhook events, keeping the deployments they produced', async () => {
    const t = await tenant();
    const old = await t.run('deployment_status', statusEvent({ id: 7001 }));
    const fresh = await t.run('deployment_status', statusEvent({ id: 7002 }));
    await prisma.$executeRaw`UPDATE "WebhookEvent" SET "receivedAt" = now() - interval '40 days' WHERE "id" = ${old.event.id}::uuid`;
    expect(await cleanupOldWebhookEvents(prisma, 30)).toBeGreaterThanOrEqual(1);
    expect(await prisma.webhookEvent.findUnique({ where: { id: old.event.id } })).toBeNull();
    expect(await prisma.webhookEvent.findUnique({ where: { id: fresh.event.id } })).not.toBeNull();
    expect(await prisma.deployment.count({ where: { integrationId: t.integration.id } })).toBe(2);
  });

  it('is enforced by the database: no cross-tenant deployment, duplicate delivery or bad sha', async () => {
    const a = await tenant();
    const b = await tenant();
    // A deployment cannot point at another organization's project, service or integration.
    await expect(
      prisma.deployment.create({
        data: {
          organizationId: a.organizationId,
          projectId: b.projectId,
          integrationId: a.integration.id,
          externalId: 'x1',
          environment: 'production',
          ref: 'main',
          commitSha: 'c'.repeat(40),
          status: 'SUCCESS',
          startedAt: at('2026-09-20T10:00:00Z'),
          statusUpdatedAt: at('2026-09-20T10:00:00Z'),
        },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.deployment.create({
        data: {
          organizationId: a.organizationId,
          projectId: a.projectId,
          integrationId: b.integration.id,
          externalId: 'x2',
          environment: 'production',
          ref: 'main',
          commitSha: 'c'.repeat(40),
          status: 'SUCCESS',
          startedAt: at('2026-09-20T10:00:00Z'),
          statusUpdatedAt: at('2026-09-20T10:00:00Z'),
        },
      }),
    ).rejects.toThrow();
    // A malformed commit sha is rejected by a CHECK constraint.
    await expect(
      prisma.deployment.create({
        data: {
          organizationId: a.organizationId,
          projectId: a.projectId,
          integrationId: a.integration.id,
          externalId: 'x3',
          environment: 'production',
          ref: 'main',
          commitSha: 'NOT A SHA',
          status: 'SUCCESS',
          startedAt: at('2026-09-20T10:00:00Z'),
          statusUpdatedAt: at('2026-09-20T10:00:00Z'),
        },
      }),
    ).rejects.toThrow();
    // Two ACTIVE integrations for one repository are refused; a disabled one is fine.
    await expect(
      prisma.gitHubIntegration.create({
        data: {
          organizationId: a.organizationId,
          projectId: a.projectId,
          repoFullName: REPO.toUpperCase(),
          webhookSecretEncrypted: 'v1:x',
        },
      }),
    ).rejects.toThrow();
    await prisma.gitHubIntegration.update({
      where: { id: a.integration.id },
      data: { status: 'DISABLED' },
    });
    await expect(
      prisma.gitHubIntegration.create({
        data: {
          organizationId: a.organizationId,
          projectId: a.projectId,
          repoFullName: REPO,
          webhookSecretEncrypted: 'v1:x',
        },
      }),
    ).resolves.toBeDefined();
  });
});
