import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@nexus/database';
import type { HealthCheckPayload } from '@nexus/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLogger } from '../logger';
import { HAS_DB, seedCheck, seedCheckedService, seedService, testPrisma } from '../testing/db';
import { claimDueChecks, dispatchDueChecks, type HealthCheckQueue } from './dispatcher';
import { processHealthCheck } from './health-check';
import type { CheckResult, Checker } from './http-checker';
import { cleanupOldResults } from './maintenance';

const logger = createLogger('silent');
const UP: CheckResult = { status: 'UP', statusCode: 200, responseTimeMs: 12, failureReason: null };
const DOWN: CheckResult = {
  status: 'DOWN',
  statusCode: 500,
  responseTimeMs: 30,
  failureReason: 'unexpected_status',
};
const REFUSED: CheckResult = {
  status: 'DOWN',
  statusCode: null,
  responseTimeMs: null,
  failureReason: 'connection_refused',
};

/** A checker that returns the given results in order, one per call. */
function scripted(...results: CheckResult[]): Checker {
  const queue = [...results];
  return async () => queue.shift() ?? UP;
}

let slot = 0;
const payloadFor = (check: { checkId: string; organizationId: string }): HealthCheckPayload => ({
  checkId: check.checkId,
  organizationId: check.organizationId,
  // Each call is a distinct scheduled slot (a distinct execution).
  scheduledFor: new Date(Date.UTC(2026, 0, 1, 0, 0, slot++)).toISOString(),
});

describe.skipIf(!HAS_DB)('monitoring (integration)', () => {
  let prisma: PrismaClient;
  beforeAll(() => {
    prisma = testPrisma();
  });
  afterAll(() => prisma.$disconnect());

  const run = (
    check: Parameters<typeof payloadFor>[0],
    checker: Checker,
    payload = payloadFor(check),
  ) => processHealthCheck({ prisma, check: checker, logger }, payload);
  const state = (checkId: string) =>
    prisma.monitoringCheck.findUniqueOrThrow({ where: { id: checkId } });
  const serviceOf = (id: string) => prisma.service.findUniqueOrThrow({ where: { id } });
  const incidentsOf = (serviceId: string) =>
    prisma.incident.findMany({
      where: { serviceId },
      orderBy: { number: 'asc' },
      include: { events: { orderBy: { createdAt: 'asc' } } },
    });

  describe('recording results and health', () => {
    it('a passing check records a result and makes the check and its service HEALTHY', async () => {
      const seeded = await seedCheckedService(prisma);
      const outcome = await run(seeded, scripted(UP));
      expect(outcome).toMatchObject({ kind: 'recorded', transition: null, incidentId: null });

      expect(await state(seeded.checkId)).toMatchObject({
        healthStatus: 'HEALTHY',
        consecutiveFailures: 0,
      });
      const service = await serviceOf(seeded.serviceId);
      expect(service.healthStatus).toBe('HEALTHY');
      expect(service.healthChangedAt).not.toBeNull();
      const results = await prisma.monitoringResult.findMany({
        where: { checkId: seeded.checkId },
      });
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        status: 'UP',
        statusCode: 200,
        responseTimeMs: 12,
        failureReason: null,
        organizationId: seeded.organizationId,
      });
    });

    it('failures BELOW the threshold change nothing visible: no DOWN, no incident', async () => {
      const seeded = await seedCheckedService(prisma, { failureThreshold: 3 });
      await run(seeded, scripted(DOWN));
      await run(seeded, scripted(DOWN));
      expect(await state(seeded.checkId)).toMatchObject({
        healthStatus: 'UNKNOWN',
        consecutiveFailures: 2,
      });
      expect((await serviceOf(seeded.serviceId)).healthStatus).toBe('UNKNOWN');
      expect(await incidentsOf(seeded.serviceId)).toHaveLength(0);
      expect(
        await prisma.monitoringResult.count({ where: { checkId: seeded.checkId, status: 'DOWN' } }),
      ).toBe(2);
    });

    it('a success in the middle resets the streak, so a transient blip never opens an incident', async () => {
      const seeded = await seedCheckedService(prisma, { failureThreshold: 3 });
      for (const result of [DOWN, DOWN, UP, DOWN, DOWN]) await run(seeded, scripted(result));
      expect(await incidentsOf(seeded.serviceId)).toHaveLength(0);
      expect((await state(seeded.checkId)).consecutiveFailures).toBe(2);
    });

    it('stores the failure reason and status code of failed checks', async () => {
      const seeded = await seedCheckedService(prisma);
      await run(seeded, scripted(REFUSED));
      await run(seeded, scripted(DOWN));
      const results = await prisma.monitoringResult.findMany({
        where: { checkId: seeded.checkId },
        orderBy: { scheduledFor: 'asc' },
      });
      expect(results.map((r) => [r.failureReason, r.statusCode])).toEqual([
        ['connection_refused', null],
        ['unexpected_status', 500],
      ]);
    });
  });

  describe('incident creation', () => {
    it('opens exactly one MONITORING incident when the failure threshold is reached', async () => {
      const seeded = await seedCheckedService(prisma, {
        failureThreshold: 3,
        incidentSeverity: 'SEV1',
        url: 'https://api.example.com/health?token=SUPERSECRET',
      });
      const outcomes = [];
      for (let i = 0; i < 3; i++) outcomes.push(await run(seeded, scripted(DOWN)));

      expect(outcomes.map((o) => (o.kind === 'recorded' ? o.transition : 'skipped'))).toEqual([
        null,
        null,
        'WENT_DOWN',
      ]);
      expect((await serviceOf(seeded.serviceId)).healthStatus).toBe('DOWN');

      const incidents = await incidentsOf(seeded.serviceId);
      expect(incidents).toHaveLength(1);
      const incident = incidents[0]!;
      expect(incident).toMatchObject({
        source: 'MONITORING',
        status: 'OPEN',
        severity: 'SEV1',
        createdById: null,
        title: 'Checkout API (production) is down',
        organizationId: seeded.organizationId,
        number: 1,
      });
      expect(incident.description).toContain('failed 3 times in a row');
      expect(incident.description).toContain('https://api.example.com/health');
      // Query strings can carry credentials: they must never be copied into an incident.
      expect(incident.description).not.toContain('SUPERSECRET');

      expect(incident.events).toHaveLength(1);
      expect(incident.events[0]).toMatchObject({
        type: 'CREATED',
        actorType: 'SYSTEM',
        actorId: null,
      });
      expect(incident.events[0]!.data).toMatchObject({
        detectedBy: 'monitoring',
        checkId: seeded.checkId,
        reason: 'unexpected_status',
        statusCode: 500,
      });
      const tags = await prisma.incidentTag.findMany({ where: { incidentId: incident.id } });
      expect(tags.map((t) => t.tag)).toEqual(['monitoring']);
    });

    it('continued failures do not open more incidents', async () => {
      const seeded = await seedCheckedService(prisma, { failureThreshold: 2 });
      for (let i = 0; i < 6; i++) await run(seeded, scripted(DOWN));
      expect(await incidentsOf(seeded.serviceId)).toHaveLength(1);
    });

    it('a threshold of 1 (opt-in) opens an incident on the very first failure', async () => {
      const seeded = await seedCheckedService(prisma, { failureThreshold: 1 });
      await run(seeded, scripted(DOWN));
      expect(await incidentsOf(seeded.serviceId)).toHaveLength(1);
    });

    it('createIncidents=false still marks the service DOWN but opens no incident', async () => {
      const seeded = await seedCheckedService(prisma, {
        failureThreshold: 1,
        createIncidents: false,
      });
      await run(seeded, scripted(DOWN));
      expect((await serviceOf(seeded.serviceId)).healthStatus).toBe('DOWN');
      expect(await incidentsOf(seeded.serviceId)).toHaveLength(0);
    });

    it('takes the next per-organisation incident number', async () => {
      const service = await seedService(prisma);
      await prisma.organization.update({
        where: { id: service.organizationId },
        data: { incidentCounter: 41 },
      });
      const seeded = { ...service, ...(await seedCheck(prisma, service, { failureThreshold: 1 })) };
      await run(seeded, scripted(DOWN));
      expect((await incidentsOf(seeded.serviceId))[0]!.number).toBe(42);
      expect(
        (await prisma.organization.findUniqueOrThrow({ where: { id: seeded.organizationId } }))
          .incidentCounter,
      ).toBe(42);
    });
  });

  describe('recovery and repeated outages', () => {
    it('recovery marks the service HEALTHY and annotates the incident, but does NOT resolve it', async () => {
      const seeded = await seedCheckedService(prisma, {
        failureThreshold: 2,
        recoveryThreshold: 2,
      });
      for (const r of [DOWN, DOWN]) await run(seeded, scripted(r));
      const first = await run(seeded, scripted(UP));
      expect(first).toMatchObject({ transition: null }); // one success is not enough
      expect((await serviceOf(seeded.serviceId)).healthStatus).toBe('DOWN');

      const second = await run(seeded, scripted(UP));
      expect(second).toMatchObject({ transition: 'RECOVERED' });
      expect((await serviceOf(seeded.serviceId)).healthStatus).toBe('HEALTHY');

      const [incident] = await incidentsOf(seeded.serviceId);
      expect(incident!.status).toBe('OPEN'); // a human confirms resolution
      const signal = incident!.events.find((e) => e.type === 'MONITORING_SIGNAL')!;
      expect(signal).toMatchObject({ actorType: 'SYSTEM' });
      expect(signal.data).toMatchObject({ kind: 'recovered', serviceHealth: 'HEALTHY' });
    });

    it('a new outage after the incident was resolved opens a NEW incident', async () => {
      const seeded = await seedCheckedService(prisma, {
        failureThreshold: 1,
        recoveryThreshold: 1,
      });
      await run(seeded, scripted(DOWN));
      await run(seeded, scripted(UP));
      const [first] = await incidentsOf(seeded.serviceId);
      await prisma.incident.update({
        where: { id: first!.id },
        data: { status: 'RESOLVED', resolvedAt: new Date() },
      });

      await run(seeded, scripted(DOWN));
      const incidents = await incidentsOf(seeded.serviceId);
      expect(incidents.map((i) => [i.number, i.status])).toEqual([
        [1, 'RESOLVED'],
        [2, 'OPEN'],
      ]);
    });

    it('a repeat outage while the earlier incident is still open annotates it instead of duplicating', async () => {
      const seeded = await seedCheckedService(prisma, {
        failureThreshold: 1,
        recoveryThreshold: 1,
      });
      await run(seeded, scripted(DOWN));
      await run(seeded, scripted(UP));
      await run(seeded, scripted(DOWN));
      const incidents = await incidentsOf(seeded.serviceId);
      expect(incidents).toHaveLength(1);
      expect(incidents[0]!.events.map((e) => (e.data as { kind?: string }).kind ?? e.type)).toEqual(
        ['went_down', 'recovered', 'went_down_again'],
      );
    });
  });

  describe('several checks per service', () => {
    it('service health is the worst of its checks, and recovers only when none is DOWN', async () => {
      const service = await seedService(prisma);
      const a = await seedCheck(prisma, service, {
        name: 'A',
        failureThreshold: 1,
        recoveryThreshold: 1,
      });
      const b = await seedCheck(prisma, service, {
        name: 'B',
        failureThreshold: 1,
        recoveryThreshold: 1,
      });
      await run(b, scripted(UP));
      expect((await serviceOf(service.serviceId)).healthStatus).toBe('HEALTHY');
      await run(a, scripted(DOWN));
      expect((await serviceOf(service.serviceId)).healthStatus).toBe('DOWN');
      await run(b, scripted(UP)); // B is fine, A still down
      expect((await serviceOf(service.serviceId)).healthStatus).toBe('DOWN');
      await run(a, scripted(UP));
      expect((await serviceOf(service.serviceId)).healthStatus).toBe('HEALTHY');
    });

    it('two checks failing at the same instant open ONE incident, not two (concurrency)', async () => {
      const service = await seedService(prisma);
      const a = await seedCheck(prisma, service, { name: 'A', failureThreshold: 1 });
      const b = await seedCheck(prisma, service, { name: 'B', failureThreshold: 1 });
      const outcomes = await Promise.all([run(a, scripted(DOWN)), run(b, scripted(DOWN))]);
      expect(outcomes.every((o) => o.kind === 'recorded')).toBe(true);
      expect(await incidentsOf(service.serviceId)).toHaveLength(1);
      const events = (await incidentsOf(service.serviceId))[0]!.events;
      expect(events.filter((e) => e.type === 'CREATED')).toHaveLength(1);
    });
  });

  describe('idempotency and safety', () => {
    it('processing the same scheduled slot twice records it once', async () => {
      const seeded = await seedCheckedService(prisma, { failureThreshold: 5 });
      const payload = payloadFor(seeded);
      const first = await run(seeded, scripted(DOWN), payload);
      const second = await run(seeded, scripted(DOWN), payload);
      expect(first.kind).toBe('recorded');
      expect(second).toEqual({ kind: 'skipped', reason: 'duplicate' });
      expect(await prisma.monitoringResult.count({ where: { checkId: seeded.checkId } })).toBe(1);
      expect((await state(seeded.checkId)).consecutiveFailures).toBe(1); // counted once
    });

    it('a burst of identical concurrent jobs is still recorded exactly once', async () => {
      const seeded = await seedCheckedService(prisma, { failureThreshold: 1 });
      const payload = payloadFor(seeded);
      const outcomes = await Promise.all(
        Array.from({ length: 6 }, () => run(seeded, scripted(DOWN), payload)),
      );
      expect(outcomes.filter((o) => o.kind === 'recorded')).toHaveLength(1);
      expect(await prisma.monitoringResult.count({ where: { checkId: seeded.checkId } })).toBe(1);
      expect(await incidentsOf(seeded.serviceId)).toHaveLength(1);
    });

    it('skips disabled, deleted and archived checks without recording anything', async () => {
      const disabled = await seedCheckedService(prisma, { enabled: false });
      expect(await run(disabled, scripted(DOWN))).toEqual({ kind: 'skipped', reason: 'disabled' });

      const gone = await seedCheckedService(prisma);
      await prisma.monitoringCheck.delete({ where: { id: gone.checkId } });
      expect(await run(gone, scripted(DOWN))).toEqual({ kind: 'skipped', reason: 'not_found' });

      const archived = await seedCheckedService(prisma);
      await prisma.service.update({
        where: { id: archived.serviceId },
        data: { archivedAt: new Date() },
      });
      expect(await run(archived, scripted(DOWN))).toEqual({ kind: 'skipped', reason: 'archived' });

      for (const seeded of [disabled, archived]) {
        expect(await prisma.monitoringResult.count({ where: { checkId: seeded.checkId } })).toBe(0);
      }
    });

    it("a job naming another organisation's check id is ignored (tenant scoping)", async () => {
      const victim = await seedCheckedService(prisma, { failureThreshold: 1 });
      const attacker = await seedService(prisma);
      const outcome = await run(victim, scripted(DOWN), {
        ...payloadFor(victim),
        organizationId: attacker.organizationId,
      });
      expect(outcome).toEqual({ kind: 'skipped', reason: 'not_found' });
      expect(await prisma.monitoringResult.count({ where: { checkId: victim.checkId } })).toBe(0);
      expect(await incidentsOf(victim.serviceId)).toHaveLength(0);
    });

    it('a crashing checker propagates (so the job is retried) and leaves no partial state', async () => {
      const seeded = await seedCheckedService(prisma);
      const boom: Checker = async () => {
        throw new Error('checker exploded');
      };
      await expect(run(seeded, boom)).rejects.toThrow('checker exploded');
      expect(await prisma.monitoringResult.count({ where: { checkId: seeded.checkId } })).toBe(0);
      expect((await state(seeded.checkId)).consecutiveFailures).toBe(0);
    });
  });

  describe('the dispatcher', () => {
    class RecordingQueue implements HealthCheckQueue {
      jobs: Array<{ data: HealthCheckPayload; jobId?: string }> = [];
      failFor = new Set<string>();
      async add(_name: string, data: HealthCheckPayload, options: { jobId?: string }) {
        if (this.failFor.has(data.checkId)) throw new Error('redis unavailable');
        this.jobs.push({ data, jobId: options.jobId });
      }
      forOrg(organizationId: string) {
        return this.jobs.filter((job) => job.data.organizationId === organizationId);
      }
    }
    const past = () => new Date(Date.now() - 60_000);
    const future = () => new Date(Date.now() + 3_600_000);

    it('claims only enabled, due checks, and schedules the next run one interval ahead', async () => {
      const service = await seedService(prisma);
      const due = await seedCheck(prisma, service, {
        name: 'due',
        nextRunAt: past(),
        intervalSeconds: 120,
      });
      const notDue = await seedCheck(prisma, service, { name: 'later', nextRunAt: future() });
      const disabled = await seedCheck(prisma, service, {
        name: 'off',
        nextRunAt: past(),
        enabled: false,
      });

      const queue = new RecordingQueue();
      await dispatchDueChecks(prisma, queue, logger, 100, service.organizationId);

      expect(queue.forOrg(service.organizationId).map((j) => j.data.checkId)).toEqual([
        due.checkId,
      ]);
      const next = (await state(due.checkId)).nextRunAt.getTime();
      expect(next).toBeGreaterThan(Date.now() + 100_000); // ~ now + 120s
      expect(next).toBeLessThan(Date.now() + 140_000);
      expect((await state(notDue.checkId)).nextRunAt.getTime()).toBeGreaterThan(
        Date.now() + 3_000_000,
      ); // untouched
      expect((await state(disabled.checkId)).nextRunAt.getTime()).toBeLessThan(Date.now()); // untouched
    });

    it('does not enqueue the same check again before its next run is due', async () => {
      const service = await seedService(prisma);
      await seedCheck(prisma, service, { nextRunAt: past() });
      const queue = new RecordingQueue();
      await dispatchDueChecks(prisma, queue, logger, 100, service.organizationId);
      await dispatchDueChecks(prisma, queue, logger, 100, service.organizationId);
      expect(queue.forOrg(service.organizationId)).toHaveLength(1);
    });

    it('several dispatchers at once (several workers) enqueue each check exactly once', async () => {
      const service = await seedService(prisma);
      const checks = await Promise.all(
        Array.from({ length: 12 }, (_, i) =>
          seedCheck(prisma, service, { name: `c${i}`, nextRunAt: past() }),
        ),
      );
      const queue = new RecordingQueue();
      await Promise.all(
        Array.from({ length: 5 }, () =>
          dispatchDueChecks(prisma, queue, logger, 100, service.organizationId),
        ),
      );
      const enqueued = queue
        .forOrg(service.organizationId)
        .map((j) => j.data.checkId)
        .sort();
      expect(enqueued).toEqual(checks.map((c) => c.checkId).sort());
    });

    it('gives each job a deterministic id derived from the check and the slot, and a valid payload', async () => {
      const service = await seedService(prisma);
      const check = await seedCheck(prisma, service, { nextRunAt: past() });
      const queue = new RecordingQueue();
      await dispatchDueChecks(prisma, queue, logger, 100, service.organizationId);
      const [job] = queue.forOrg(service.organizationId);
      expect(job!.jobId).toMatch(new RegExp(`^hc-${check.checkId}-\\d+$`));
      expect(job!.jobId).not.toContain(':'); // BullMQ forbids ':' in custom ids
      expect(job!.data).toEqual({
        checkId: check.checkId,
        organizationId: service.organizationId,
        scheduledFor: expect.stringMatching(/Z$/),
      });
    });

    it('makes a check due again if it could not be enqueued (no silently skipped interval)', async () => {
      const service = await seedService(prisma);
      const check = await seedCheck(prisma, service, { nextRunAt: past(), intervalSeconds: 3600 });
      const queue = new RecordingQueue();
      queue.failFor.add(check.checkId);
      await dispatchDueChecks(prisma, queue, logger, 100, service.organizationId);
      expect(queue.forOrg(service.organizationId)).toHaveLength(0);
      expect((await state(check.checkId)).nextRunAt.getTime()).toBeLessThanOrEqual(
        Date.now() + 1000,
      );
    });

    it('"run now" (nextRunAt = now) is picked up on the next tick', async () => {
      const service = await seedService(prisma);
      const check = await seedCheck(prisma, service, { nextRunAt: future() });
      await prisma.monitoringCheck.update({
        where: { id: check.checkId },
        data: { nextRunAt: new Date() },
      });
      const queue = new RecordingQueue();
      await dispatchDueChecks(prisma, queue, logger, 100, service.organizationId);
      expect(queue.forOrg(service.organizationId)).toHaveLength(1);
    });

    it('respects the batch limit', async () => {
      const service = await seedService(prisma);
      await Promise.all(
        Array.from({ length: 5 }, (_, i) =>
          seedCheck(prisma, service, {
            name: `b${i}`,
            nextRunAt: new Date(Date.now() - 86_400_000 * 30),
          }),
        ),
      );
      const claimed = await claimDueChecks(prisma, 2);
      expect(claimed.length).toBeLessThanOrEqual(2);
    });
  });

  describe('result retention', () => {
    it('deletes only results older than the retention window', async () => {
      const seeded = await seedCheckedService(prisma);
      const mk = (days: number, i: number) => ({
        organizationId: seeded.organizationId,
        checkId: seeded.checkId,
        status: 'UP' as const,
        statusCode: 200,
        responseTimeMs: 5,
        scheduledFor: new Date(Date.UTC(2026, 0, 1, 0, 0, i)),
        checkedAt: new Date(Date.now() - days * 86_400_000),
      });
      await prisma.monitoringResult.createMany({
        data: [mk(90, 1), mk(31, 2), mk(29, 3), mk(1, 4), mk(0, 5)],
      });

      const deleted = await cleanupOldResults(prisma, 30);
      expect(deleted).toBeGreaterThanOrEqual(2);
      const remaining = await prisma.monitoringResult.findMany({
        where: { checkId: seeded.checkId },
        orderBy: { scheduledFor: 'asc' },
      });
      expect(remaining.map((r) => r.scheduledFor.getUTCSeconds())).toEqual([3, 4, 5]);
    });

    it('works through a large backlog in batches', async () => {
      const seeded = await seedCheckedService(prisma);
      await prisma.monitoringResult.createMany({
        data: Array.from({ length: 25 }, (_, i) => ({
          organizationId: seeded.organizationId,
          checkId: seeded.checkId,
          status: 'UP' as const,
          scheduledFor: new Date(Date.UTC(2026, 1, 1, 0, 0, i)),
          checkedAt: new Date(Date.now() - 100 * 86_400_000),
        })),
      });
      await cleanupOldResults(prisma, 30, 4); // batch size 4 → several rounds
      expect(await prisma.monitoringResult.count({ where: { checkId: seeded.checkId } })).toBe(0);
    });
  });

  describe('database constraints', () => {
    it('reject invalid check settings even when written directly', async () => {
      const service = await seedService(prisma);
      const base = {
        organizationId: service.organizationId,
        serviceId: service.serviceId,
        name: 'x',
        url: 'https://example.com',
      };
      const bad: Array<[string, Record<string, unknown>]> = [
        ['timeout too small', { timeoutMs: 10 }],
        ['timeout too large', { timeoutMs: 60_000 }],
        ['interval too small', { intervalSeconds: 5 }],
        ['threshold zero', { failureThreshold: 0 }],
        ['status out of range', { expectedStatus: 700 }],
        ['non-http url', { url: 'ftp://example.com' }],
      ];
      for (const [label, extra] of bad) {
        await expect(
          prisma.monitoringCheck.create({ data: { ...base, ...extra } }),
          label,
        ).rejects.toThrow();
      }
    });

    it('a service can have at most one ACTIVE monitoring incident (partial unique index)', async () => {
      const seeded = await seedCheckedService(prisma, { failureThreshold: 1 });
      await run(seeded, scripted(DOWN));
      await expect(
        prisma.$executeRaw`INSERT INTO "Incident" ("organizationId","number","serviceId","title","severity","source","updatedAt")
          VALUES (${seeded.organizationId}::uuid, 900, ${seeded.serviceId}::uuid, 'dup', 'SEV3', 'MONITORING', now())`,
      ).rejects.toThrow(/23505/);
      // A MANUAL incident for the same service is unaffected.
      await expect(
        prisma.$executeRaw`INSERT INTO "Incident" ("organizationId","number","serviceId","title","severity","source","updatedAt")
          VALUES (${seeded.organizationId}::uuid, 901, ${seeded.serviceId}::uuid, 'manual', 'SEV3', 'MANUAL', now())`,
      ).resolves.toBe(1);
    });

    it('a monitoring incident must name a service, and results must explain failures', async () => {
      const seeded = await seedCheckedService(prisma);
      await expect(
        prisma.$executeRaw`INSERT INTO "Incident" ("organizationId","number","title","severity","source","updatedAt")
          VALUES (${seeded.organizationId}::uuid, 902, 'no service', 'SEV3', 'MONITORING', now())`,
      ).rejects.toThrow(/Incident_monitoring_has_service_check/);
      await expect(
        prisma.$executeRaw`INSERT INTO "MonitoringResult" ("organizationId","checkId","status","scheduledFor")
          VALUES (${seeded.organizationId}::uuid, ${seeded.checkId}::uuid, 'DOWN', now())`,
      ).rejects.toThrow(/MonitoringResult_reason_consistency_check/);
    });

    it("cross-tenant references are impossible: a check cannot point at another organisation's service", async () => {
      const a = await seedService(prisma);
      const b = await seedService(prisma);
      await expect(
        prisma.$executeRaw`INSERT INTO "MonitoringCheck" ("organizationId","serviceId","name","url","updatedAt")
          VALUES (${a.organizationId}::uuid, ${b.serviceId}::uuid, 'x', 'https://example.com', now())`,
      ).rejects.toThrow(/23503|foreign key/i);
      const check = await seedCheck(prisma, b);
      await expect(
        prisma.$executeRaw`INSERT INTO "MonitoringResult" ("organizationId","checkId","status","scheduledFor")
          VALUES (${a.organizationId}::uuid, ${check.checkId}::uuid, 'UP', ${new Date()})`,
      ).rejects.toThrow(/23503|foreign key/i);
    });

    it('deleting a check deletes its results; unknown ids never match', async () => {
      const seeded = await seedCheckedService(prisma);
      await run(seeded, scripted(UP));
      await prisma.monitoringCheck.delete({ where: { id: seeded.checkId } });
      expect(await prisma.monitoringResult.count({ where: { checkId: seeded.checkId } })).toBe(0);
      expect(await prisma.monitoringCheck.count({ where: { id: randomUUID() } })).toBe(0);
    });
  });
});
