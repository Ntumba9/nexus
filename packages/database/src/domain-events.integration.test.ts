import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { emitDeploymentStatusEvent, toFacts } from './domain-events';
import { createPrismaClient } from './index';
import { createIncidentRecord, recordIncidentEvent } from './incident-writes';
import { recomputeServiceHealth } from './service-health';

// Requires PostgreSQL with migrations applied.
const url = process.env.DATABASE_URL;

describe('toFacts', () => {
  it('keeps flat scalars only and cuts long strings', () => {
    const facts = toFacts({
      a: 'x',
      b: 1,
      c: true,
      d: null,
      nested: { secret: 'no' },
      list: [1, 2],
      fn: () => 1,
      u: undefined,
      long: 'y'.repeat(2000),
    });
    expect(Object.keys(facts).sort()).toEqual(['a', 'b', 'c', 'd', 'long']);
    expect((facts.long as string).length).toBe(500);
  });
});

describe.skipIf(!url)('domain events are written with the change (integration)', () => {
  const prisma = createPrismaClient(url ?? 'postgresql://unused');
  afterAll(() => prisma.$disconnect());

  let orgId: string;
  let projectId: string;
  let serviceId: string;
  let userId: string;

  beforeAll(async () => {
    const suffix = randomUUID().slice(0, 8);
    const org = await prisma.organization.create({
      data: { name: `Org ${suffix}`, slug: `org-${suffix}` },
    });
    orgId = org.id;
    const project = await prisma.project.create({
      data: { organizationId: orgId, name: 'P', slug: `p-${suffix}` },
    });
    projectId = project.id;
    const service = await prisma.service.create({
      data: { organizationId: orgId, projectId, name: 'Checkout API' },
    });
    serviceId = service.id;
    const user = await prisma.user.create({
      data: {
        email: `u-${suffix}@example.com`,
        name: 'Alex Admin',
        passwordHash: '$argon2id$test-only-not-a-real-hash',
      },
    });
    userId = user.id;
  });

  const events = (where: Record<string, unknown> = {}) =>
    prisma.domainEvent.findMany({
      where: { organizationId: orgId, ...where },
      orderBy: { occurredAt: 'asc' },
    });
  const clear = () => prisma.domainEvent.deleteMany({ where: { organizationId: orgId } });

  const newIncident = (over: Record<string, unknown> = {}) =>
    prisma.$transaction((tx) =>
      createIncidentRecord(tx, {
        organizationId: orgId,
        title: 'Checkout is slow',
        severity: 'SEV2',
        serviceId,
        source: 'MANUAL',
        actor: { type: 'USER', id: userId },
        ...over,
      }),
    );

  it('writes exactly one incident.created event with the incident facts', async () => {
    await clear();
    const incident = await newIncident();
    const [event, ...rest] = await events();
    expect(rest).toEqual([]);
    expect(event).toMatchObject({
      type: 'incident.created',
      subjectId: incident.id,
      causedByExecutionId: null,
      dispatchedAt: null,
    });
    expect(event!.facts).toEqual({
      incidentId: incident.id,
      number: incident.number,
      title: 'Checkout is slow',
      severity: 'SEV2',
      status: 'OPEN',
      source: 'MANUAL',
      serviceId,
      serviceName: 'Checkout API',
    });
  });

  it('leaves no event behind when the transaction rolls back (and no incident either)', async () => {
    await clear();
    const before = await prisma.incident.count({ where: { organizationId: orgId } });
    await expect(
      prisma.$transaction(async (tx) => {
        await createIncidentRecord(tx, {
          organizationId: orgId,
          title: 'Doomed',
          severity: 'SEV1',
          source: 'MANUAL',
          actor: { type: 'USER', id: userId },
        });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await events()).toEqual([]);
    expect(await prisma.incident.count({ where: { organizationId: orgId } })).toBe(before);
  });

  it('turns status, severity and assignment changes into events, with what changed', async () => {
    const incident = await newIncident();
    await clear();
    const record = (type: 'STATUS_CHANGED' | 'SEVERITY_CHANGED' | 'ASSIGNED', data: object) =>
      prisma.$transaction((tx) =>
        recordIncidentEvent(tx, {
          organizationId: orgId,
          incidentId: incident.id,
          type,
          actor: { type: 'USER', id: userId },
          data: data as never,
        }),
      );
    await record('STATUS_CHANGED', { from: 'OPEN', to: 'ACKNOWLEDGED' });
    await record('SEVERITY_CHANGED', { from: 'SEV2', to: 'SEV1' });
    await record('ASSIGNED', { userId, name: 'Alex Admin' });

    const found = await events();
    expect(found.map((e) => e.type)).toEqual([
      'incident.status_changed',
      'incident.severity_changed',
      'incident.assigned',
    ]);
    expect(found[0]!.facts).toMatchObject({
      fromStatus: 'OPEN',
      toStatus: 'ACKNOWLEDGED',
      number: incident.number,
    });
    expect(found[1]!.facts).toMatchObject({ fromSeverity: 'SEV2', toSeverity: 'SEV1' });
    expect(found[2]!.facts).toMatchObject({ assigneeUserId: userId, assigneeName: 'Alex Admin' });
    expect(found.every((e) => e.subjectId === incident.id)).toBe(true);
  });

  it('announces nothing for timeline events automation does not react to', async () => {
    const incident = await newIncident();
    await clear();
    for (const type of [
      'UPDATED',
      'COMMENT_ADDED',
      'UNASSIGNED',
      'MONITORING_SIGNAL',
      'DEPLOYMENT_LINKED',
    ] as const) {
      await prisma.$transaction((tx) =>
        recordIncidentEvent(tx, {
          organizationId: orgId,
          incidentId: incident.id,
          type,
          actor: { type: 'SYSTEM', id: null },
          data: {},
        }),
      );
    }
    expect(await events()).toEqual([]);
    // ...but every one of them is still on the timeline.
    expect(
      await prisma.incidentEvent.count({
        where: { incidentId: incident.id, type: 'COMMENT_ADDED' },
      }),
    ).toBe(1);
  });

  it('records that an automation caused an event, for the loop guard', async () => {
    await clear();
    const executionId = randomUUID();
    await newIncident({
      source: 'AUTOMATION',
      actor: { type: 'AUTOMATION', id: null },
      causedByExecutionId: executionId,
    });
    const [event] = await events();
    expect(event).toMatchObject({ type: 'incident.created', causedByExecutionId: executionId });
    expect(event!.facts).toMatchObject({ source: 'AUTOMATION' });
  });

  it('announces a service health change once, and not when nothing changed', async () => {
    await clear();
    const check = await prisma.monitoringCheck.create({
      data: {
        organizationId: orgId,
        serviceId,
        name: 'c',
        url: 'https://example.com/h',
        healthStatus: 'HEALTHY',
      },
    });
    const recompute = () =>
      prisma.$transaction((tx) => recomputeServiceHealth(tx, orgId, serviceId));

    expect(await recompute()).toMatchObject({ changed: true, from: 'UNKNOWN', to: 'HEALTHY' });
    expect(await recompute()).toMatchObject({ changed: false });
    await prisma.monitoringCheck.update({
      where: { id: check.id },
      data: { healthStatus: 'DOWN' },
    });
    expect(await recompute()).toMatchObject({ changed: true, from: 'HEALTHY', to: 'DOWN' });

    const found = await events({ type: 'service.health_changed' });
    expect(found).toHaveLength(2);
    expect(found[0]!.facts).toEqual({
      serviceId,
      serviceName: 'Checkout API',
      projectId,
      environment: 'PRODUCTION',
      fromHealth: 'UNKNOWN',
      toHealth: 'HEALTHY',
    });
    expect(found[1]!.facts).toMatchObject({ fromHealth: 'HEALTHY', toHealth: 'DOWN' });
    await prisma.monitoringCheck.delete({ where: { id: check.id } });
  });

  it('announces deployments that reach SUCCESS or FAILURE, and no other status', async () => {
    await clear();
    const integration = await prisma.gitHubIntegration.create({
      data: {
        organizationId: orgId,
        projectId,
        serviceId,
        repoFullName: `acme/${randomUUID().slice(0, 8)}`,
        webhookSecretEncrypted: 'v1:x',
      },
    });
    const deploy = async (status: 'PENDING' | 'IN_PROGRESS' | 'SUCCESS' | 'FAILURE') => {
      const now = new Date();
      const d = await prisma.deployment.create({
        data: {
          organizationId: orgId,
          projectId,
          serviceId,
          integrationId: integration.id,
          externalId: randomUUID(),
          environment: 'production',
          ref: 'main',
          commitSha: 'abcdef1234567890abcdef1234567890abcdef12',
          author: 'octocat',
          status,
          startedAt: now,
          statusUpdatedAt: now,
        },
      });
      return prisma.$transaction((tx) => emitDeploymentStatusEvent(tx, orgId, d.id));
    };

    expect(await deploy('PENDING')).toBeNull();
    expect(await deploy('IN_PROGRESS')).toBeNull();
    expect(await deploy('SUCCESS')).not.toBeNull();
    expect(await deploy('FAILURE')).not.toBeNull();

    const found = await events();
    expect(found.map((e) => e.type)).toEqual(['deployment.succeeded', 'deployment.failed']);
    expect(found[0]!.facts).toMatchObject({
      serviceName: 'Checkout API',
      environment: 'production',
      commitShort: 'abcdef1',
      author: 'octocat',
      status: 'SUCCESS',
    });
    expect(await emitDeploymentStatusEvent(prisma, orgId, randomUUID())).toBeNull(); // unknown id
  });
});
