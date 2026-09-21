import { randomUUID } from 'node:crypto';
import { AI_LIMITS, chunkMarkdown, type ContextSource } from '@nexus/shared';
import { afterAll, describe, expect, it } from 'vitest';
import {
  assembleIncidentContext,
  createEmbeddingProvider,
  createIncidentRecord,
  createPrismaClient,
  embedDocumentChunks,
  recordIncidentEvent,
  replaceDocumentChunks,
} from './index';

// Requires PostgreSQL with migrations applied. Goes straight to the database: what the assembler
// reads, what it refuses to read, and what the schema guarantees on its own.
const url = process.env.DATABASE_URL;

describe.skipIf(!url)('AI investigation context and schema (integration)', () => {
  const prisma = createPrismaClient(url ?? 'postgresql://unused');
  const local = createEmbeddingProvider({ provider: 'local' });
  afterAll(() => prisma.$disconnect());

  /** A fresh organization with a project, a service and a user. */
  async function tenant() {
    const suffix = randomUUID().slice(0, 8);
    const org = await prisma.organization.create({
      data: { name: `Org ${suffix}`, slug: `org-${suffix}` },
    });
    const project = await prisma.project.create({
      data: { organizationId: org.id, name: 'Payments', slug: `payments-${suffix}` },
    });
    const service = await prisma.service.create({
      data: { organizationId: org.id, projectId: project.id, name: 'Checkout API' },
    });
    const user = await prisma.user.create({
      data: {
        email: `u-${suffix}@example.com`,
        name: 'Ada Lovelace',
        passwordHash: '$argon2id$test-only-not-a-real-hash',
      },
    });
    await prisma.organizationMember.create({
      data: { organizationId: org.id, userId: user.id, role: 'ADMIN' },
    });
    const integration = await prisma.gitHubIntegration.create({
      data: {
        organizationId: org.id,
        projectId: project.id,
        serviceId: service.id,
        repoFullName: `acme/${suffix}`,
        webhookSecretEncrypted: 'v1:not-used',
      },
    });
    return {
      orgId: org.id,
      projectId: project.id,
      serviceId: service.id,
      userId: user.id,
      integrationId: integration.id,
    };
  }
  type Tenant = Awaited<ReturnType<typeof tenant>>;

  const incident = (
    t: Tenant,
    over: { title?: string; description?: string; tags?: string[]; serviceId?: string | null } = {},
  ) =>
    prisma.$transaction((tx) =>
      createIncidentRecord(tx, {
        organizationId: t.orgId,
        title: over.title ?? 'Checkout errors',
        description: over.description ?? '',
        severity: 'SEV2',
        serviceId: over.serviceId === undefined ? t.serviceId : over.serviceId,
        source: 'MANUAL',
        actor: { type: 'USER', id: t.userId },
        ...(over.tags ? { tags: over.tags } : {}),
      }),
    );

  const deployment = (t: Tenant, minutesAgo: number, over: Record<string, unknown> = {}) => {
    const at = new Date(Date.now() - minutesAgo * 60_000);
    return prisma.deployment.create({
      data: {
        organizationId: t.orgId,
        projectId: t.projectId,
        serviceId: t.serviceId,
        integrationId: t.integrationId,
        externalId: randomUUID(),
        environment: 'production',
        ref: 'main',
        commitSha: randomUUID().replace(/-/g, '') + 'abcdefab',
        status: 'SUCCESS',
        author: 'grace',
        startedAt: at,
        deployedAt: at,
        statusUpdatedAt: at,
        ...over,
      },
    });
  };

  const kinds = (sources: ContextSource[]) => [...new Set(sources.map((s) => s.kind))];
  const allText = (sources: ContextSource[]) =>
    sources.map((s) => `${s.title}\n${s.text}`).join('\n');

  it('gathers the timeline, deployments, health checks, earlier incidents and runbooks, each labelled', async () => {
    const t = await tenant();
    const earlier = await incident(t, { title: 'Checkout timeouts last week' });
    await prisma.incident.update({
      where: { id: earlier.id },
      data: {
        createdAt: new Date(Date.now() - 4 * 24 * 3_600_000),
        status: 'RESOLVED',
        resolvedAt: new Date(),
      },
    });
    await deployment(t, 20);
    const check = await prisma.monitoringCheck.create({
      data: {
        organizationId: t.orgId,
        serviceId: t.serviceId,
        name: 'Health',
        url: 'https://example.com/h',
      },
    });
    for (let i = 0; i < 3; i += 1) {
      await prisma.monitoringResult.create({
        data: {
          organizationId: t.orgId,
          checkId: check.id,
          status: 'DOWN',
          statusCode: 500,
          responseTimeMs: 900,
          failureReason: 'unexpected_status',
          scheduledFor: new Date(Date.now() - (i + 1) * 60_000),
          checkedAt: new Date(Date.now() - (i + 1) * 60_000),
        },
      });
    }
    const doc = await prisma.$transaction(async (tx) => {
      const md =
        '# Restart\nRestart the checkout service with the deploy tool and watch the error rate.';
      const d = await tx.knowledgeDocument.create({
        data: {
          organizationId: t.orgId,
          title: 'Checkout restart runbook',
          slug: `rb-${randomUUID().slice(0, 8)}`,
          contentMd: md,
        },
      });
      await replaceDocumentChunks(tx, t.orgId, d.id, chunkMarkdown(d.title, md));
      return d;
    });
    await embedDocumentChunks(prisma, local, { organizationId: t.orgId, documentId: doc.id });
    const current = await incident(t, {
      title: 'Checkout errors after deploy',
      tags: ['payments'],
    });

    const ctx = (await assembleIncidentContext(prisma, {
      organizationId: t.orgId,
      incidentId: current.id,
      embeddings: local,
    }))!;

    expect(ctx.incident).toMatchObject({
      number: current.number,
      title: 'Checkout errors after deploy',
      serviceName: 'Checkout API',
      tags: ['payments'],
    });
    expect(kinds(ctx.sources).sort()).toEqual([
      'deployment',
      'incident_event',
      'knowledge',
      'monitoring',
      'previous_incident',
    ]);
    // Labels are unique, prefixed by kind and numbered from 1.
    const labels = ctx.sources.map((s) => s.label);
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels).toContain('INC-EVT-1');
    expect(labels).toContain('DEP-1');
    expect(labels).toContain('MON-3');
    expect(labels).toContain('INC-PREV-1');
    expect(labels).toContain('KB-1');
    // Structured facts, taken from the records.
    const dep = ctx.sources.find((s) => s.label === 'DEP-1')!;
    expect(dep.facts).toMatchObject({ status: 'SUCCESS', environment: 'production', ref: 'main' });
    expect(Number(dep.facts.minutesBeforeOnset)).toBeGreaterThan(0);
    expect(ctx.sources.find((s) => s.label === 'MON-1')!.facts).toMatchObject({
      status: 'DOWN',
      failureReason: 'unexpected_status',
    });
    expect(ctx.sources.find((s) => s.label === 'INC-PREV-1')!.facts).toMatchObject({
      status: 'RESOLVED',
    });
    expect(ctx.sources.find((s) => s.label === 'KB-1')!.refId).toBe(doc.id);
    expect(ctx.truncated).toBe(false);
  });

  it('works for an incident with no service, and returns null for an unknown one', async () => {
    const t = await tenant();
    const bare = await incident(t, { serviceId: null });
    const ctx = (await assembleIncidentContext(prisma, {
      organizationId: t.orgId,
      incidentId: bare.id,
    }))!;
    expect(kinds(ctx.sources)).toEqual(['incident_event']);
    expect(ctx.incident.serviceName).toBeNull();
    await expect(
      assembleIncidentContext(prisma, { organizationId: t.orgId, incidentId: randomUUID() }),
    ).resolves.toBeNull();
  });

  it('never reads another organization’s data, and refuses an incident that is not in the organization', async () => {
    const a = await tenant();
    const b = await tenant();
    // Bravo has a deployment, a failing check, a runbook and an incident, all mentioning "vault".
    await deployment(b, 5, { description: 'bravo vault rotation' });
    const bravoCheck = await prisma.monitoringCheck.create({
      data: {
        organizationId: b.orgId,
        serviceId: b.serviceId,
        name: 'Bravo vault check',
        url: 'https://example.com/v',
      },
    });
    await prisma.monitoringResult.create({
      data: {
        organizationId: b.orgId,
        checkId: bravoCheck.id,
        status: 'DOWN',
        failureReason: 'timeout',
        scheduledFor: new Date(),
        checkedAt: new Date(),
      },
    });
    const secretDoc = await prisma.$transaction(async (tx) => {
      const md = '# Vault\nThe bravo vault rotation password procedure.';
      const d = await tx.knowledgeDocument.create({
        data: {
          organizationId: b.orgId,
          title: 'Bravo vault runbook',
          slug: `rb-${randomUUID().slice(0, 8)}`,
          contentMd: md,
        },
      });
      await replaceDocumentChunks(tx, b.orgId, d.id, chunkMarkdown(d.title, md));
      return d;
    });
    await embedDocumentChunks(prisma, local, { organizationId: b.orgId, documentId: secretDoc.id });
    const bravoIncident = await incident(b, { title: 'Bravo vault outage' });

    const alphaIncident = await incident(a, {
      title: 'Vault rotation problem',
      description: 'bravo vault rotation password procedure',
    });
    const ctx = (await assembleIncidentContext(prisma, {
      organizationId: a.orgId,
      incidentId: alphaIncident.id,
      embeddings: local,
    }))!;
    expect(allText(ctx.sources)).not.toMatch(/bravo/i);
    expect(ctx.sources.some((s) => s.refId === secretDoc.id || s.refId === bravoIncident.id)).toBe(
      false,
    );

    // Asking about Bravo's incident under Alpha's organization finds nothing at all.
    await expect(
      assembleIncidentContext(prisma, { organizationId: a.orgId, incidentId: bravoIncident.id }),
    ).resolves.toBeNull();
  });

  it('removes secrets from everything it reads, before anything is stored or sent', async () => {
    const t = await tenant();
    const inc = await incident(t, {
      title: 'Leaked key sk-live-abcdefghijklmnopqrstuv',
      description: 'DB_PASSWORD=hunter2hunter2 and postgres://admin:pw123456@db/app',
    });
    await prisma.$transaction((tx) =>
      recordIncidentEvent(tx, {
        organizationId: t.orgId,
        incidentId: inc.id,
        type: 'COMMENT_ADDED',
        actor: { type: 'USER', id: t.userId },
        data: { body: 'token ghp_abcdefghijklmnopqrstuvwxyz0123456789 was pasted here' },
      }),
    );
    await deployment(t, 10, { description: 'rotated Bearer abcdef1234567890xyz' });
    const ctx = (await assembleIncidentContext(prisma, {
      organizationId: t.orgId,
      incidentId: inc.id,
    }))!;
    const everything = JSON.stringify(ctx);
    for (const secret of [
      'sk-live-abcdef',
      'hunter2hunter2',
      'pw123456',
      'ghp_abcdefghijkl',
      'abcdef1234567890xyz',
    ]) {
      expect(everything, secret).not.toContain(secret);
    }
    expect(everything).toContain('[redacted]');
  });

  it('stays within the size budget, keeps how the incident was opened, and says it left things out', async () => {
    const t = await tenant();
    const inc = await incident(t, { title: 'Chatty incident' });
    for (let i = 0; i < 30; i += 1) {
      await prisma.$transaction((tx) =>
        recordIncidentEvent(tx, {
          organizationId: t.orgId,
          incidentId: inc.id,
          type: 'COMMENT_ADDED',
          actor: { type: 'USER', id: t.userId },
          data: { body: `comment ${i} ${'lorem ipsum dolor sit amet '.repeat(70)}` },
        }),
      );
    }
    for (let i = 0; i < 8; i += 1) await deployment(t, 10 + i, { description: 'x'.repeat(1500) });
    const ctx = (await assembleIncidentContext(prisma, {
      organizationId: t.orgId,
      incidentId: inc.id,
    }))!;
    const size = ctx.sources.reduce((n, s) => n + s.title.length + s.text.length, 0);
    expect(size).toBeLessThanOrEqual(AI_LIMITS.maxContextChars);
    expect(ctx.truncated).toBe(true);
    expect(ctx.sources.every((s) => s.text.length <= AI_LIMITS.maxSourceChars)).toBe(true);
    // The event that opened the incident survives the cuts.
    expect(ctx.sources.find((s) => s.label === 'INC-EVT-1')!.text).toContain(
      'opened this incident',
    );
  });

  it('leaves out its own earlier runs, so an investigation is not fed its own output', async () => {
    const t = await tenant();
    const inc = await incident(t);
    await prisma.$transaction((tx) =>
      recordIncidentEvent(tx, {
        organizationId: t.orgId,
        incidentId: inc.id,
        type: 'AI_INVESTIGATED',
        actor: { type: 'SYSTEM', id: null },
        data: { provider: 'x' },
      }),
    );
    const ctx = (await assembleIncidentContext(prisma, {
      organizationId: t.orgId,
      incidentId: inc.id,
    }))!;
    expect(allText(ctx.sources)).not.toMatch(/ai investigated/i);
    expect(ctx.sources.filter((s) => s.kind === 'incident_event')).toHaveLength(1);
  });

  describe('AiInvestigation schema guarantees', () => {
    const investigation = (t: Tenant, incidentId: string, data: Record<string, unknown> = {}) =>
      prisma.aiInvestigation.create({
        data: {
          organizationId: t.orgId,
          incidentId,
          providerId: 'rules-v1',
          providerLabel: 'Rules',
          ...data,
        },
      });

    it('allows only one queued or running investigation per incident', async () => {
      const t = await tenant();
      const inc = await incident(t);
      const first = await investigation(t, inc.id);
      await expect(investigation(t, inc.id)).rejects.toThrow();
      await expect(investigation(t, inc.id, { status: 'RUNNING' })).rejects.toThrow();
      // Once it is over, another may start; finished ones never conflict.
      await prisma.aiInvestigation.update({
        where: { id: first.id },
        data: { status: 'FAILED', error: 'x', finishedAt: new Date() },
      });
      await expect(investigation(t, inc.id)).resolves.toBeTruthy();
      await expect(
        investigation(t, inc.id, { status: 'FAILED', error: 'y', finishedAt: new Date() }),
      ).resolves.toBeTruthy();
    });

    it('requires an answer exactly when it succeeded, and a finish time exactly when it is over', async () => {
      const t = await tenant();
      const inc = await incident(t);
      const output = { summary: 's' };
      await expect(
        investigation(t, inc.id, { status: 'SUCCEEDED', finishedAt: new Date() }),
      ).rejects.toThrow(); // no output
      await expect(
        investigation(t, inc.id, { status: 'FAILED', output, error: 'x', finishedAt: new Date() }),
      ).rejects.toThrow(); // output on a failure
      await expect(investigation(t, inc.id, { status: 'FAILED', error: 'x' })).rejects.toThrow(); // over but no finishedAt
      await expect(
        investigation(t, inc.id, { status: 'QUEUED', finishedAt: new Date() }),
      ).rejects.toThrow(); // finishedAt while active
      await expect(
        investigation(t, inc.id, { status: 'SUCCEEDED', output, finishedAt: new Date() }),
      ).resolves.toBeTruthy();
    });

    it('limits the failure reason and the question, and rejects negative counts', async () => {
      const t = await tenant();
      const inc = await incident(t);
      const over = { status: 'FAILED', finishedAt: new Date() };
      await expect(investigation(t, inc.id, { ...over, error: 'x'.repeat(301) })).rejects.toThrow();
      await expect(investigation(t, inc.id, { question: 'q'.repeat(501) })).rejects.toThrow();
      await expect(
        investigation(t, inc.id, { ...over, error: 'x', droppedCitations: -1 }),
      ).rejects.toThrow();
      // A reason on a non-failure is refused too.
      await expect(investigation(t, inc.id, { status: 'RUNNING', error: 'x' })).rejects.toThrow();
    });

    it('cannot point at another organization’s incident', async () => {
      const a = await tenant();
      const b = await tenant();
      const bravoIncident = await incident(b);
      await expect(investigation(a, bravoIncident.id)).rejects.toThrow();
    });
  });
});
