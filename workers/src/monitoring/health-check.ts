import {
  recordIncidentEvent,
  createIncidentRecord,
  recomputeServiceHealth,
  type Prisma,
  type PrismaClient,
} from '@nexus/database';
import {
  FAILURE_REASON_LABEL,
  evaluateCheck,
  type CheckTransition,
  type FailureReason,
  type HealthCheckPayload,
} from '@nexus/shared';
import type { Logger } from '../logger';
import type { Checker, CheckResult } from './http-checker';

export interface HealthCheckDeps {
  prisma: PrismaClient;
  check: Checker;
  logger: Logger;
  now?: () => Date;
}

export type HealthCheckOutcome =
  | { kind: 'skipped'; reason: 'not_found' | 'disabled' | 'archived' | 'duplicate' }
  | {
      kind: 'recorded';
      result: CheckResult;
      transition: CheckTransition;
      incidentId: string | null;
    };

/** The monitoring incident title. */
const incidentTitle = (service: { name: string; environment: string }) =>
  `${service.name} (${service.environment.toLowerCase()}) is down`;

/** Origin and path only: query strings often carry tokens and must not be copied into incidents. */
function safeUrlLabel(raw: string): string {
  try {
    const url = new URL(raw);
    return `${url.origin}${url.pathname}`;
  } catch {
    return '(invalid URL)';
  }
}

function describeFailure(result: CheckResult): string {
  const reason = result.failureReason
    ? FAILURE_REASON_LABEL[result.failureReason as FailureReason]
    : 'Unknown failure';
  return result.statusCode ? `${reason} (HTTP ${result.statusCode})` : reason;
}

/**
 * Executes one scheduled check and applies its consequences.
 *
 * Order of work matters:
 *  1. The HTTP request happens OUTSIDE any database transaction, so a slow target never holds locks.
 *  2. The result and every consequence (counters, service health, incident, timeline) are then
 *     written in ONE transaction, under row locks on the check and its service, so concurrent
 *     workers cannot interleave.
 *  3. The result row is unique per (check, scheduled slot): a retried or duplicated job inserts
 *     nothing and the whole job becomes a no-op (idempotency).
 */
export async function processHealthCheck(
  deps: HealthCheckDeps,
  payload: HealthCheckPayload,
): Promise<HealthCheckOutcome> {
  const { prisma, logger } = deps;

  const target = await prisma.monitoringCheck.findFirst({
    where: { id: payload.checkId, organizationId: payload.organizationId },
    select: {
      url: true,
      timeoutMs: true,
      expectedStatus: true,
      enabled: true,
      service: { select: { archivedAt: true } },
    },
  });
  if (!target) return { kind: 'skipped', reason: 'not_found' };
  if (!target.enabled) return { kind: 'skipped', reason: 'disabled' };
  if (target.service.archivedAt) return { kind: 'skipped', reason: 'archived' };

  const result = await deps.check({
    url: target.url,
    timeoutMs: target.timeoutMs,
    expectedStatus: target.expectedStatus,
  });
  const checkedAt = deps.now?.() ?? new Date();

  return prisma.$transaction(async (tx): Promise<HealthCheckOutcome> => {
    // Lock order everywhere: check row, then service row.
    await tx.$queryRaw`SELECT "id" FROM "MonitoringCheck" WHERE "id" = ${payload.checkId}::uuid AND "organizationId" = ${payload.organizationId}::uuid FOR UPDATE`;
    const check = await tx.monitoringCheck.findFirst({
      where: { id: payload.checkId, organizationId: payload.organizationId },
      select: {
        serviceId: true,
        name: true,
        url: true,
        enabled: true,
        failureThreshold: true,
        recoveryThreshold: true,
        incidentSeverity: true,
        createIncidents: true,
        healthStatus: true,
        consecutiveFailures: true,
        consecutiveSuccesses: true,
        service: { select: { name: true, environment: true } },
      },
    });
    if (!check) return { kind: 'skipped', reason: 'not_found' };
    if (!check.enabled) return { kind: 'skipped', reason: 'disabled' };
    await tx.$queryRaw`SELECT "id" FROM "Service" WHERE "id" = ${check.serviceId}::uuid FOR UPDATE`;

    const inserted = await tx.monitoringResult.createMany({
      data: [
        {
          organizationId: payload.organizationId,
          checkId: payload.checkId,
          status: result.status,
          statusCode: result.statusCode,
          responseTimeMs: result.responseTimeMs,
          failureReason: result.failureReason,
          scheduledFor: new Date(payload.scheduledFor),
          checkedAt,
        },
      ],
      skipDuplicates: true,
    });
    if (inserted.count === 0) return { kind: 'skipped', reason: 'duplicate' };

    const { state, transition } = evaluateCheck(
      {
        health: check.healthStatus as 'UNKNOWN' | 'HEALTHY' | 'DOWN',
        consecutiveFailures: check.consecutiveFailures,
        consecutiveSuccesses: check.consecutiveSuccesses,
      },
      result.status,
      { failureThreshold: check.failureThreshold, recoveryThreshold: check.recoveryThreshold },
    );
    await tx.monitoringCheck.updateMany({
      where: { id: payload.checkId, organizationId: payload.organizationId },
      data: {
        healthStatus: state.health,
        consecutiveFailures: state.consecutiveFailures,
        consecutiveSuccesses: state.consecutiveSuccesses,
        lastCheckedAt: checkedAt,
      },
    });
    const change = await recomputeServiceHealth(
      tx,
      payload.organizationId,
      check.serviceId,
      checkedAt,
    );

    let incidentId: string | null = null;
    if (transition === 'WENT_DOWN') {
      logger.warn('check went down', {
        checkId: payload.checkId,
        serviceId: check.serviceId,
        failures: state.consecutiveFailures,
      });
      incidentId = await openOrNoteIncident(tx, {
        organizationId: payload.organizationId,
        serviceId: check.serviceId,
        service: check.service,
        checkId: payload.checkId,
        checkName: check.name,
        url: check.url,
        severity: check.incidentSeverity,
        createIncidents: check.createIncidents,
        failures: state.consecutiveFailures,
        result,
      });
    } else if (transition === 'RECOVERED') {
      logger.info('check recovered', { checkId: payload.checkId, serviceId: check.serviceId });
      incidentId = await noteRecovery(tx, {
        organizationId: payload.organizationId,
        serviceId: check.serviceId,
        checkId: payload.checkId,
        checkName: check.name,
        serviceHealth: change.to,
      });
    }
    return { kind: 'recorded', result, transition, incidentId };
  });
}

interface DownContext {
  organizationId: string;
  serviceId: string;
  service: { name: string; environment: string };
  checkId: string;
  checkName: string;
  url: string;
  severity: 'SEV1' | 'SEV2' | 'SEV3' | 'SEV4';
  createIncidents: boolean;
  failures: number;
  result: CheckResult;
}

const ACTIVE = { notIn: ['RESOLVED', 'CANCELLED'] as ('RESOLVED' | 'CANCELLED')[] };
const SYSTEM = { type: 'SYSTEM', id: null } as const;

async function findActiveMonitoringIncident(
  tx: Prisma.TransactionClient,
  organizationId: string,
  serviceId: string,
) {
  return tx.incident.findFirst({
    where: { organizationId, serviceId, source: 'MONITORING', status: ACTIVE },
    select: { id: true },
  });
}

/**
 * A service has at most one ACTIVE monitoring incident (also enforced by a partial unique index).
 * If one is already open, a new failure streak is recorded on it instead of opening a duplicate.
 * The caller holds the service row lock, so this find-then-create cannot race another worker.
 */
async function openOrNoteIncident(
  tx: Prisma.TransactionClient,
  ctx: DownContext,
): Promise<string | null> {
  const active = await findActiveMonitoringIncident(tx, ctx.organizationId, ctx.serviceId);
  const detail = {
    kind: 'went_down',
    checkId: ctx.checkId,
    checkName: ctx.checkName,
    consecutiveFailures: ctx.failures,
    reason: ctx.result.failureReason,
    statusCode: ctx.result.statusCode,
  } satisfies Prisma.InputJsonObject;

  if (active) {
    await recordIncidentEvent(tx, {
      organizationId: ctx.organizationId,
      incidentId: active.id,
      type: 'MONITORING_SIGNAL',
      actor: SYSTEM,
      data: { ...detail, kind: 'went_down_again' },
    });
    return active.id;
  }
  if (!ctx.createIncidents) return null;

  const created = await createIncidentRecord(tx, {
    organizationId: ctx.organizationId,
    title: incidentTitle(ctx.service),
    description:
      `Monitoring check "${ctx.checkName}" failed ${ctx.failures} time${ctx.failures === 1 ? '' : 's'} in a row.\n` +
      `Last result: ${describeFailure(ctx.result)}.\n` +
      `Target: ${safeUrlLabel(ctx.url)}`,
    severity: ctx.severity,
    serviceId: ctx.serviceId,
    source: 'MONITORING',
    createdById: null,
    tags: ['monitoring'],
    actor: SYSTEM,
    eventData: { detectedBy: 'monitoring', ...detail },
  });
  return created.id;
}

/** Recovery never resolves an incident by itself: a human confirms. It is recorded on the timeline. */
async function noteRecovery(
  tx: Prisma.TransactionClient,
  ctx: {
    organizationId: string;
    serviceId: string;
    checkId: string;
    checkName: string;
    serviceHealth: string;
  },
): Promise<string | null> {
  const active = await findActiveMonitoringIncident(tx, ctx.organizationId, ctx.serviceId);
  if (!active) return null;
  await recordIncidentEvent(tx, {
    organizationId: ctx.organizationId,
    incidentId: active.id,
    type: 'MONITORING_SIGNAL',
    actor: SYSTEM,
    data: {
      kind: 'recovered',
      checkId: ctx.checkId,
      checkName: ctx.checkName,
      serviceHealth: ctx.serviceHealth,
    },
  });
  return active.id;
}
