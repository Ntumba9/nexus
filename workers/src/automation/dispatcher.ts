import type { PrismaClient } from '@nexus/database';
import {
  AUTOMATION_JOBS,
  conditionListSchema,
  evaluateConditions,
  publishRealtime,
  topicsForDomainEvent,
  type RealtimePublisher,
  type RealtimeTopic,
  type AutomationJobPayload,
  type Facts,
  type SkipReason,
} from '@nexus/shared';
import type { JobsOptions } from 'bullmq';
import { DEFAULT_JOB_OPTIONS } from '../create-worker';
import type { Logger } from '../logger';

/** The part of a BullMQ Queue the dispatcher needs (lets tests substitute a recording fake). */
export interface AutomationQueue {
  add(name: string, data: AutomationJobPayload, options: JobsOptions): Promise<unknown>;
}

interface ClaimedEvent {
  id: string;
  organizationId: string;
  type: string;
  subjectId: string | null;
  facts: Facts;
  causedByExecutionId: string | null;
}

export interface DispatchOptions {
  /** A rule that already ran this many times in the last hour is skipped (and the skip recorded). */
  maxExecutionsPerRulePerHour: number;
  batchSize?: number;
  /** Restrict to one organisation (tests and operational tooling); default is all. */
  organizationId?: string | null;
  /** When set, every claimed event is announced to browsers once it is committed (ADR-014). */
  realtime?: RealtimePublisher;
}

export interface DispatchResult {
  events: number;
  executions: number;
  skipped: number;
}

interface NewExecution {
  organizationId: string;
  ruleId: string;
  eventId: string;
  eventType: string;
  subjectId: string | null;
  skipReason: SkipReason | null;
}

/**
 * One tick of the rule engine: claim domain events nobody has handled, decide which rules they
 * trigger, and record one execution per match. Everything for a batch happens in ONE transaction:
 *
 *  - The claim is `FOR UPDATE SKIP LOCKED`, so several workers each get a disjoint set of events.
 *  - The executions and the "dispatched" mark commit together, so a crash before commit leaves the
 *    events untouched (they are simply claimed again) and a crash after leaves executions that the
 *    sweep below will enqueue. An event is never lost and never handled twice.
 *  - `(rule, event)` is unique, as a last line of defence.
 *
 * Events caused by an automation are marked dispatched WITHOUT running anything (the loop guard), so
 * an automation can never trigger another, however the rules are written.
 */
export async function dispatchDomainEvents(
  prisma: PrismaClient,
  queue: AutomationQueue,
  logger: Logger,
  options: DispatchOptions,
): Promise<DispatchResult> {
  const batchSize = options.batchSize ?? 50;
  const organizationId = options.organizationId ?? null;

  const { events, created, skipped, announce } = await prisma.$transaction(
    async (tx) => {
      const claimed = await tx.$queryRaw<ClaimedEvent[]>`
        SELECT "id", "organizationId", "type", "subjectId", "facts", "causedByExecutionId"
        FROM "DomainEvent"
        WHERE "dispatchedAt" IS NULL
          AND (${organizationId}::uuid IS NULL OR "organizationId" = ${organizationId}::uuid)
        ORDER BY "occurredAt" ASC
        LIMIT ${batchSize}
        FOR UPDATE SKIP LOCKED`;

      const created: AutomationJobPayload[] = [];
      let skipped = 0;
      const announce = new Map<string, Set<RealtimeTopic>>();

      for (const event of claimed) {
        // Every event is news to the browser, including ones an automation caused.
        const topics = announce.get(event.organizationId) ?? new Set<RealtimeTopic>();
        for (const topic of topicsForDomainEvent(event.type)) topics.add(topic);
        announce.set(event.organizationId, topics);
        if (event.causedByExecutionId === null) {
          const rules = await tx.automationRule.findMany({
            where: { organizationId: event.organizationId, trigger: event.type, enabled: true },
            select: { id: true, name: true, conditions: true, cooldownSeconds: true },
            orderBy: { createdAt: 'asc' },
          });

          for (const rule of rules) {
            const conditions = conditionListSchema.safeParse(rule.conditions);
            if (!conditions.success) {
              logger.error('automation rule has invalid conditions; skipping it', {
                ruleId: rule.id,
              });
              continue;
            }
            if (!evaluateConditions(conditions.data, event.facts)) continue;

            const skipReason = await shouldSkip(
              tx,
              rule,
              event,
              options.maxExecutionsPerRulePerHour,
            );
            const executionId = await insertExecution(tx, {
              organizationId: event.organizationId,
              ruleId: rule.id,
              eventId: event.id,
              eventType: event.type,
              subjectId: event.subjectId,
              skipReason,
            });
            if (!executionId) continue; // (rule, event) already exists: nothing to do
            if (skipReason) skipped += 1;
            else created.push({ executionId, organizationId: event.organizationId });
          }
        }
        await tx.$executeRaw`UPDATE "DomainEvent" SET "dispatchedAt" = now() WHERE "id" = ${event.id}::uuid`;
      }
      return { events: claimed.length, created, skipped, announce };
    },
    { timeout: 30_000 },
  );

  await enqueue(queue, created, logger);
  // After the commit, so a browser that refetches sees what the event describes.
  if (options.realtime) {
    for (const [orgId, topics] of announce) {
      await publishRealtime(
        options.realtime,
        orgId,
        [...topics].map((topic) => ({ topic })),
      );
    }
  }
  return { events, executions: created.length, skipped };
}

type Tx = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0];

/** Cooldown and hourly cap, both measured on the database clock. */
async function shouldSkip(
  tx: Tx,
  rule: { id: string; cooldownSeconds: number },
  event: ClaimedEvent,
  maxPerHour: number,
): Promise<SkipReason | null> {
  if (rule.cooldownSeconds > 0 && event.subjectId) {
    const [row] = await tx.$queryRaw<{ n: bigint }[]>`
      SELECT count(*)::bigint AS n FROM "AutomationExecution"
      WHERE "ruleId" = ${rule.id}::uuid AND "subjectId" = ${event.subjectId}::uuid
        AND "status" <> 'SKIPPED'
        AND "createdAt" > now() - make_interval(secs => ${rule.cooldownSeconds}::int)`;
    if (Number(row?.n ?? 0) > 0) return 'cooldown';
  }
  const [hour] = await tx.$queryRaw<{ n: bigint }[]>`
    SELECT count(*)::bigint AS n FROM "AutomationExecution"
    WHERE "ruleId" = ${rule.id}::uuid AND "status" <> 'SKIPPED'
      AND "createdAt" > now() - interval '1 hour'`;
  return Number(hour?.n ?? 0) >= maxPerHour ? 'rate_limited' : null;
}

async function insertExecution(tx: Tx, execution: NewExecution): Promise<string | null> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO "AutomationExecution"
      ("organizationId", "ruleId", "eventId", "eventType", "subjectId", "status", "skipReason", "finishedAt")
    VALUES (
      ${execution.organizationId}::uuid, ${execution.ruleId}::uuid, ${execution.eventId}::uuid,
      ${execution.eventType}, ${execution.subjectId}::uuid,
      (CASE WHEN ${execution.skipReason}::text IS NULL THEN 'PENDING' ELSE 'SKIPPED' END)::"ExecutionStatus",
      ${execution.skipReason}::text,
      CASE WHEN ${execution.skipReason}::text IS NULL THEN NULL ELSE now() END
    )
    ON CONFLICT ("ruleId", "eventId") DO NOTHING
    RETURNING "id"`;
  return rows[0]?.id ?? null;
}

async function enqueue(
  queue: AutomationQueue,
  jobs: readonly AutomationJobPayload[],
  logger: Logger,
): Promise<void> {
  await Promise.all(
    jobs.map(async (job) => {
      try {
        // Deterministic id: enqueueing the same execution twice is a no-op.
        await queue.add(AUTOMATION_JOBS.execute, job, {
          ...DEFAULT_JOB_OPTIONS,
          jobId: `ax-${job.executionId}`,
        });
      } catch (error) {
        // The execution stays PENDING; `enqueueStalePending` picks it up again.
        logger.error('failed to enqueue automation execution', {
          executionId: job.executionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }),
  );
}

/**
 * Re-enqueue executions that were recorded but never made it into the queue (the process died, or
 * Redis was down, between the commit and the enqueue). Safe to repeat: the job id is deterministic.
 */
export async function enqueueStalePending(
  prisma: PrismaClient,
  queue: AutomationQueue,
  logger: Logger,
  olderThanSeconds = 30,
  organizationId: string | null = null,
): Promise<number> {
  const stale = await prisma.$queryRaw<AutomationJobPayload[]>`
    SELECT "id" AS "executionId", "organizationId"
    FROM "AutomationExecution"
    WHERE "status" = 'PENDING'
      AND "createdAt" < now() - make_interval(secs => ${olderThanSeconds}::int)
      AND (${organizationId}::uuid IS NULL OR "organizationId" = ${organizationId}::uuid)
    ORDER BY "createdAt" ASC
    LIMIT 100`;
  await enqueue(queue, stale, logger);
  return stale.length;
}

/** Runs the dispatcher on an interval without overlapping ticks. */
export function startAutomationDispatcher(options: {
  prisma: PrismaClient;
  queue: AutomationQueue;
  logger: Logger;
  intervalMs: number;
  maxExecutionsPerRulePerHour: number;
  realtime?: RealtimePublisher;
}): { stop(): Promise<void> } {
  let running = false;
  let stopped = false;
  let inFlight: Promise<void> = Promise.resolve();
  let ticks = 0;

  const tick = () => {
    if (running || stopped) return;
    running = true;
    ticks += 1;
    inFlight = (async () => {
      const result = await dispatchDomainEvents(options.prisma, options.queue, options.logger, {
        maxExecutionsPerRulePerHour: options.maxExecutionsPerRulePerHour,
        ...(options.realtime ? { realtime: options.realtime } : {}),
      });
      if (result.events > 0) options.logger.debug('dispatched domain events', { ...result });
      // Look for orphaned executions occasionally, not on every tick.
      if (ticks % 30 === 0)
        await enqueueStalePending(options.prisma, options.queue, options.logger);
    })()
      .catch((error: unknown) => {
        options.logger.error('automation dispatcher tick failed', {
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
