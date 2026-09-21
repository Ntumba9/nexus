import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { PrismaClient } from '@nexus/database';
import { QUEUE_NAMES } from '@nexus/shared';
import { Queue } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorker } from '../create-worker';
import { createLogger } from '../logger';
import { healthCheckWorker } from '../processors/monitoring';
import { createBullConnection } from '../redis';
import { HAS_DB_AND_REDIS, seedCheckedService, testPrisma } from '../testing/db';
import { dispatchDueChecks } from './dispatcher';
import { createHttpChecker } from './http-checker';

/**
 * The whole monitoring path with real components: PostgreSQL (state), the dispatcher (claims due
 * checks), Redis + BullMQ (transport), the worker, the real HTTP checker and a real HTTP target.
 */
describe.skipIf(!HAS_DB_AND_REDIS)('monitoring pipeline (integration)', () => {
  const logger = createLogger('silent');
  let prisma: PrismaClient;
  let target: http.Server;
  let targetUrl: string;
  let targetStatus = 500;
  let queue: Queue;
  let worker: { close(): Promise<void> };
  const connection = createBullConnection(process.env.REDIS_URL ?? 'redis://unused');

  beforeAll(async () => {
    prisma = testPrisma();
    target = http.createServer((_req, res) => res.writeHead(targetStatus).end());
    await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve));
    targetUrl = `http://127.0.0.1:${(target.address() as AddressInfo).port}/health`;

    queue = new Queue(QUEUE_NAMES.healthCheck, { connection });
    worker = createWorker(
      healthCheckWorker({ prisma, check: createHttpChecker({ allowPrivate: true }), logger }, 2),
      connection,
      logger,
    );
  });

  afterAll(async () => {
    await worker.close();
    await queue.close();
    connection.disconnect();
    target.closeAllConnections();
    target.close();
    await prisma.$disconnect();
  });

  async function waitFor<T>(
    read: () => Promise<T | null | false>,
    what: string,
    timeoutMs = 25_000,
  ): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = await read();
      if (value) return value;
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  it(
    'detects an outage, opens an incident, then detects recovery: dispatcher → Redis → worker → HTTP → PostgreSQL',
    { timeout: 60_000 },
    async () => {
      const seeded = await seedCheckedService(prisma, {
        url: targetUrl,
        failureThreshold: 1,
        recoveryThreshold: 1,
        incidentSeverity: 'SEV1',
        nextRunAt: new Date(Date.now() - 1000),
      });
      const resultsOf = () =>
        prisma.monitoringResult.findMany({
          where: { checkId: seeded.checkId },
          orderBy: { checkedAt: 'asc' },
        });

      // 1. The target is failing: the first scheduled run must detect it.
      expect(await dispatchDueChecks(prisma, queue, logger, 100, seeded.organizationId)).toBe(1);
      const firstResults = await waitFor(async () => {
        const rows = await resultsOf();
        return rows.length >= 1 && rows;
      }, 'the first result');
      expect(firstResults[0]).toMatchObject({
        status: 'DOWN',
        statusCode: 500,
        failureReason: 'unexpected_status',
      });

      await waitFor(
        async () =>
          (await prisma.service.findUniqueOrThrow({ where: { id: seeded.serviceId } }))
            .healthStatus === 'DOWN',
        'service DOWN',
      );
      const incident = await prisma.incident.findFirstOrThrow({
        where: { serviceId: seeded.serviceId },
        include: { events: true },
      });
      expect(incident).toMatchObject({
        source: 'MONITORING',
        severity: 'SEV1',
        status: 'OPEN',
        number: 1,
      });
      expect(incident.events[0]).toMatchObject({ type: 'CREATED', actorType: 'SYSTEM' });

      // 2. Not due again yet: dispatching immediately schedules nothing for this check.
      expect(await dispatchDueChecks(prisma, queue, logger, 100, seeded.organizationId)).toBe(0);

      // 3. The target recovers; ask for a run now.
      targetStatus = 200;
      await prisma.monitoringCheck.update({
        where: { id: seeded.checkId },
        data: { nextRunAt: new Date(Date.now() - 5_000) }, // past: the database clock may lag ours
      });
      expect(await dispatchDueChecks(prisma, queue, logger, 100, seeded.organizationId)).toBe(1);

      await waitFor(async () => (await resultsOf()).length >= 2, 'the second result');
      const service = await waitFor(async () => {
        const s = await prisma.service.findUniqueOrThrow({ where: { id: seeded.serviceId } });
        return s.healthStatus === 'HEALTHY' && s;
      }, 'service HEALTHY');
      expect(service.healthChangedAt).not.toBeNull();

      const results = await resultsOf();
      expect(results.map((r) => r.status)).toEqual(['DOWN', 'UP']);
      const after = await prisma.incident.findFirstOrThrow({
        where: { serviceId: seeded.serviceId },
        include: { events: { orderBy: { createdAt: 'asc' } } },
      });
      expect(after.status).toBe('OPEN'); // recovery never resolves an incident on its own
      expect(after.events.map((e) => e.type)).toEqual(['CREATED', 'MONITORING_SIGNAL']);
    },
  );
});
