import type { ServiceHealth } from '@prisma/client';
import { aggregateServiceHealth } from '@nexus/shared';
import { emitDomainEvent } from './domain-events';
import type { Tx } from './incident-writes';

export interface HealthChange {
  changed: boolean;
  from: ServiceHealth;
  to: ServiceHealth;
}

/**
 * Recompute a service's health from its ENABLED checks and store it (with the time it changed) if it
 * differs. A service with no enabled checks is UNKNOWN ("not monitored"), never healthy by default.
 *
 * Called with the caller's transaction by the worker (after a result) and by the API (when a check is
 * disabled, deleted or re-enabled). Both take locks in the same order (check row, then service row),
 * so they cannot deadlock each other.
 */
export async function recomputeServiceHealth(
  tx: Tx,
  organizationId: string,
  serviceId: string,
  now: Date = new Date(),
): Promise<HealthChange> {
  const [checks, service] = await Promise.all([
    tx.monitoringCheck.findMany({
      where: { organizationId, serviceId, enabled: true },
      select: { healthStatus: true },
    }),
    tx.service.findFirst({
      where: { id: serviceId, organizationId },
      select: { healthStatus: true, name: true, projectId: true, environment: true },
    }),
  ]);
  if (!service) return { changed: false, from: 'UNKNOWN', to: 'UNKNOWN' };

  const next = aggregateServiceHealth(checks.map((check) => check.healthStatus)) as ServiceHealth;
  if (next === service.healthStatus) return { changed: false, from: next, to: next };

  await tx.service.updateMany({
    where: { id: serviceId, organizationId },
    data: { healthStatus: next, healthChangedAt: now },
  });
  await emitDomainEvent(tx, {
    organizationId,
    type: 'service.health_changed',
    subjectId: serviceId,
    facts: {
      serviceId,
      serviceName: service.name,
      projectId: service.projectId,
      environment: service.environment,
      fromHealth: service.healthStatus,
      toHealth: next,
    },
  });
  return { changed: true, from: service.healthStatus, to: next };
}
