import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@nexus/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HAS_DB, seedService, testPrisma } from '../testing/db';
import { processWebhookEvent } from './process-webhook';

const REPO = 'acme/storefront';

const statusEvent = (state: string, statusAt: string, id = 5001) => ({
  deployment_status: { state, created_at: statusAt },
  deployment: {
    id,
    sha: 'c'.repeat(40),
    ref: 'main',
    environment: 'production',
    created_at: '2026-09-20T10:00:00Z',
    creator: { login: 'octocat' },
  },
  repository: { full_name: REPO },
});

/** A deployment reaching SUCCESS or FAILURE is announced to automation, once, and only then. */
describe.skipIf(!HAS_DB)('deployments announce themselves (integration)', () => {
  let prisma: PrismaClient;
  beforeAll(() => {
    prisma = testPrisma();
  });
  afterAll(() => prisma.$disconnect());

  async function tenant() {
    const base = await seedService(prisma, 'Checkout API');
    const integration = await prisma.gitHubIntegration.create({
      data: {
        organizationId: base.organizationId,
        projectId: base.projectId,
        serviceId: base.serviceId,
        repoFullName: REPO,
        webhookSecretEncrypted: 'v1:not-used',
      },
    });
    const run = async (payload: unknown) => {
      const event = await prisma.webhookEvent.create({
        data: {
          organizationId: base.organizationId,
          integrationId: integration.id,
          deliveryId: randomUUID(),
          eventType: 'deployment_status',
          payload: payload as object,
        },
      });
      return processWebhookEvent(
        { prisma },
        { webhookEventId: event.id, organizationId: base.organizationId },
      );
    };
    const announced = () =>
      prisma.domainEvent.findMany({
        where: { organizationId: base.organizationId },
        orderBy: { occurredAt: 'asc' },
      });
    return { ...base, run, announced };
  }

  it('announces a successful deployment once, with its facts', async () => {
    const t = await tenant();
    await t.run(statusEvent('success', '2026-09-20T10:05:00Z'));
    const found = await t.announced();
    expect(found.map((e) => e.type)).toEqual(['deployment.succeeded']);
    expect(found[0]!.facts).toMatchObject({
      repoFullName: REPO,
      environment: 'production',
      commitShort: 'ccccccc',
      author: 'octocat',
      serviceName: 'Checkout API',
      status: 'SUCCESS',
    });
    expect(found[0]!.causedByExecutionId).toBeNull();
  });

  it('announces a failure as deployment.failed', async () => {
    const t = await tenant();
    await t.run(statusEvent('failure', '2026-09-20T10:05:00Z'));
    expect((await t.announced()).map((e) => e.type)).toEqual(['deployment.failed']);
  });

  it('stays silent while a deployment is queued or in progress, then announces its outcome once', async () => {
    const t = await tenant();
    await t.run(statusEvent('queued', '2026-09-20T10:00:10Z'));
    await t.run(statusEvent('in_progress', '2026-09-20T10:01:00Z'));
    expect(await t.announced()).toEqual([]);
    await t.run(statusEvent('success', '2026-09-20T10:05:00Z'));
    expect((await t.announced()).map((e) => e.type)).toEqual(['deployment.succeeded']);
  });

  it('does not announce a repeat of the status it already has, a stale status, or a later inactive one', async () => {
    const t = await tenant();
    await t.run(statusEvent('success', '2026-09-20T10:05:00Z'));
    await t.run(statusEvent('success', '2026-09-20T10:06:00Z')); // same status again
    await t.run(statusEvent('failure', '2026-09-20T10:01:00Z')); // older than what we have: ignored
    await t.run(statusEvent('inactive', '2026-09-20T11:00:00Z')); // superseded: not a trigger
    expect((await t.announced()).map((e) => e.type)).toEqual(['deployment.succeeded']);
  });

  it('announces a change of outcome (success, then a later failure) as two events', async () => {
    const t = await tenant();
    await t.run(statusEvent('success', '2026-09-20T10:05:00Z'));
    await t.run(statusEvent('failure', '2026-09-20T10:30:00Z'));
    expect((await t.announced()).map((e) => e.type)).toEqual([
      'deployment.succeeded',
      'deployment.failed',
    ]);
  });
});
