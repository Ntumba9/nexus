import type { AutomationTrigger, Facts, FactValue } from '@nexus/shared';
import type { Prisma } from '@prisma/client';
import type { Tx } from './incident-writes';

/**
 * The transactional outbox. Whatever changes something automation may care about writes a
 * `DomainEvent` in the SAME transaction as the change. A rolled-back change therefore leaves no
 * event behind, and a committed change can never lose its event because a process died before
 * enqueueing anything. The worker's dispatcher picks the events up afterwards.
 */

export interface NewDomainEvent {
  organizationId: string;
  type: AutomationTrigger;
  /** The record the event is about (incident, service or deployment id); used for cooldowns. */
  subjectId?: string | null;
  facts: Record<string, unknown>;
  /** Set when an automation execution caused this. Such events never trigger automation. */
  causedByExecutionId?: string | null;
}

const MAX_FACT_LENGTH = 500;

/** Facts are flat scalars only: objects, arrays and functions are dropped, long strings are cut. */
export function toFacts(input: Record<string, unknown>): Facts {
  const facts: Facts = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === null || typeof value === 'boolean' || typeof value === 'number') {
      facts[key] = value as FactValue;
    } else if (typeof value === 'string') {
      facts[key] = value.slice(0, MAX_FACT_LENGTH);
    }
  }
  return facts;
}

export async function emitDomainEvent(tx: Tx, event: NewDomainEvent): Promise<string> {
  const created = await tx.domainEvent.create({
    data: {
      organizationId: event.organizationId,
      type: event.type,
      subjectId: event.subjectId ?? null,
      facts: toFacts(event.facts) as Prisma.InputJsonObject,
      causedByExecutionId: event.causedByExecutionId ?? null,
    },
    select: { id: true },
  });
  return created.id;
}

/** The current facts of an incident, shared by every incident trigger. */
export async function incidentFacts(
  tx: Tx,
  organizationId: string,
  incidentId: string,
): Promise<Facts> {
  const incident = await tx.incident.findFirst({
    where: { id: incidentId, organizationId },
    select: {
      number: true,
      title: true,
      severity: true,
      status: true,
      source: true,
      serviceId: true,
      service: { select: { name: true } },
    },
  });
  if (!incident) return { incidentId };
  return toFacts({
    incidentId,
    number: incident.number,
    title: incident.title,
    severity: incident.severity,
    status: incident.status,
    source: incident.source,
    serviceId: incident.serviceId,
    serviceName: incident.service?.name ?? null,
  });
}

/**
 * Emits `deployment.succeeded` or `deployment.failed` for a deployment that just reached that
 * status. Any other status is not a trigger and emits nothing. Returns the event id, or null.
 */
export async function emitDeploymentStatusEvent(
  tx: Tx,
  organizationId: string,
  deploymentId: string,
): Promise<string | null> {
  const deployment = await tx.deployment.findFirst({
    where: { id: deploymentId, organizationId },
    select: {
      id: true,
      serviceId: true,
      environment: true,
      ref: true,
      commitSha: true,
      author: true,
      status: true,
      service: { select: { name: true } },
      integration: { select: { repoFullName: true } },
    },
  });
  if (!deployment) return null;
  const type =
    deployment.status === 'SUCCESS'
      ? 'deployment.succeeded'
      : deployment.status === 'FAILURE'
        ? 'deployment.failed'
        : null;
  if (!type) return null;
  return emitDomainEvent(tx, {
    organizationId,
    type,
    subjectId: deployment.id,
    facts: {
      deploymentId: deployment.id,
      serviceId: deployment.serviceId,
      serviceName: deployment.service?.name ?? null,
      repoFullName: deployment.integration.repoFullName,
      environment: deployment.environment,
      ref: deployment.ref,
      commitSha: deployment.commitSha,
      commitShort: deployment.commitSha.slice(0, 7),
      author: deployment.author,
      status: deployment.status,
    },
  });
}
