import type { PrismaClient } from '@nexus/database';
import { HEALTH_CHECK_JOBS, type HealthCheckPayload } from '@nexus/shared';
import type { JobsOptions } from 'bullmq';
import { DEFAULT_JOB_OPTIONS } from '../create-worker';
import type { Logger } from '../logger';

/** The part of a BullMQ Queue the dispatcher needs (lets tests substitute a recording fake). */
export interface HealthCheckQueue {
  add(name: string, data: HealthCheckPayload, options: JobsOptions): Promise<unknown>;
}

interface ClaimedCheck {
  id: string;
  organizationId: string;
  claimedAt: Date;
}

/**
 * Atomically claim every check that is due, and schedule its next run.
 *
 * This is the whole scheduler. It is a single UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP
 * LOCKED): concurrent dispatchers (several worker processes) each get a DISJOINT set of checks, so a
 * check is claimed once per interval no matter how many workers run. State lives in the database, so
 * a restart loses nothing, and creating, editing, disabling or "run now" from the API is simply an
 * update to `nextRunAt` (no separate scheduler registry to keep in sync).
 * The database clock is used throughout, so worker clock skew cannot matter.
 */
export async function claimDueChecks(
  prisma: PrismaClient,
  limit = 100,
  /** Restrict to one organisation (used by tests and operational tooling); default is all. */
  organizationId: string | null = null,
): Promise<ClaimedCheck[]> {
  return prisma.$queryRaw<ClaimedCheck[]>`
    UPDATE "MonitoringCheck" AS c
    SET "nextRunAt" = now() + (c."intervalSeconds" * interval '1 second')
    WHERE c."id" IN (
      SELECT "id" FROM "MonitoringCheck"
      WHERE "enabled" = true AND "nextRunAt" <= now()
        AND (${organizationId}::uuid IS NULL OR "organizationId" = ${organizationId}::uuid)
      ORDER BY "nextRunAt" ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING c."id", c."organizationId", now() AS "claimedAt"`;
}

/** Claim due checks and enqueue one job per check. Returns how many were enqueued. */
export async function dispatchDueChecks(
  prisma: PrismaClient,
  queue: HealthCheckQueue,
  logger: Logger,
  limit = 100,
  organizationId: string | null = null,
): Promise<number> {
  const claimed = await claimDueChecks(prisma, limit, organizationId);
  const failed: string[] = [];

  await Promise.all(
    claimed.map(async (check) => {
      const scheduledFor = check.claimedAt.toISOString();
      try {
        await queue.add(
          HEALTH_CHECK_JOBS.run,
          { checkId: check.id, organizationId: check.organizationId, scheduledFor },
          // Deterministic id: enqueueing the same slot twice is a no-op (BullMQ ignores duplicates).
          { ...DEFAULT_JOB_OPTIONS, jobId: `hc-${check.id}-${check.claimedAt.getTime()}` },
        );
      } catch (error) {
        failed.push(check.id);
        logger.error('failed to enqueue health check', {
          checkId: check.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }),
  );

  if (failed.length > 0) {
    // We advanced nextRunAt when claiming; if the job never made it into the queue, make the check
    // due again instead of silently skipping a whole interval.
    await prisma.$executeRaw`UPDATE "MonitoringCheck" SET "nextRunAt" = now() WHERE "id" = ANY(${failed}::uuid[])`;
  }
  return claimed.length - failed.length;
}

/** Runs `dispatchDueChecks` on an interval without overlapping ticks. */
export function startDispatcher(options: {
  prisma: PrismaClient;
  queue: HealthCheckQueue;
  logger: Logger;
  intervalMs: number;
}): { stop(): Promise<void> } {
  let running = false;
  let stopped = false;
  let inFlight: Promise<void> = Promise.resolve();

  const tick = () => {
    if (running || stopped) return;
    running = true;
    inFlight = dispatchDueChecks(options.prisma, options.queue, options.logger)
      .then((count) => {
        if (count > 0) options.logger.debug('dispatched health checks', { count });
      })
      .catch((error: unknown) => {
        options.logger.error('dispatcher tick failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        running = false;
      });
  };

  const timer = setInterval(tick, options.intervalMs);
  tick();
  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      await inFlight;
    },
  };
}
