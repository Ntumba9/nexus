import type {
  ActorType,
  IncidentEventType,
  IncidentSeverity,
  IncidentSource,
  Prisma,
} from '@prisma/client';
import type { AutomationTrigger } from '@nexus/shared';
import { emitDomainEvent, incidentFacts } from './domain-events';

/** Incident writes shared by the API (manual incidents) and workers (monitoring incidents). */
export type Tx = Prisma.TransactionClient;

export interface Actor {
  type: ActorType;
  id: string | null;
}

export interface NewIncident {
  organizationId: string;
  title: string;
  description?: string;
  severity: IncidentSeverity;
  serviceId?: string | null;
  source: IncidentSource;
  createdById?: string | null;
  tags?: string[];
  actor: Actor;
  /** Extra fields merged into the CREATED event's data (for example which check raised it). */
  eventData?: Prisma.InputJsonObject;
  /** Set when an automation execution is opening this incident (see the loop guard). */
  causedByExecutionId?: string | null;
}

/**
 * Create an incident inside the caller's transaction: allocate the next per-organisation number,
 * insert the incident and its tags, and write the CREATED timeline event, all atomically.
 *
 * The number comes from a single atomic UPDATE on the organisation row. Its row lock serialises
 * concurrent creation, and a rollback also rolls the counter back, so numbers are gap-free.
 */
export async function createIncidentRecord(
  tx: Tx,
  input: NewIncident,
): Promise<{ id: string; number: number }> {
  const { incidentCounter } = await tx.organization.update({
    where: { id: input.organizationId },
    data: { incidentCounter: { increment: 1 } },
    select: { incidentCounter: true },
  });

  const tags = input.tags ?? [];
  const incident = await tx.incident.create({
    data: {
      organizationId: input.organizationId,
      number: incidentCounter,
      serviceId: input.serviceId ?? null,
      title: input.title,
      description: input.description ?? '',
      severity: input.severity,
      source: input.source,
      createdById: input.createdById ?? null,
    },
    select: { id: true },
  });

  if (tags.length > 0) {
    await tx.incidentTag.createMany({
      data: tags.map((tag) => ({
        organizationId: input.organizationId,
        incidentId: incident.id,
        tag,
      })),
    });
  }

  await recordIncidentEvent(tx, {
    organizationId: input.organizationId,
    incidentId: incident.id,
    type: 'CREATED',
    actor: input.actor,
    causedByExecutionId: input.causedByExecutionId ?? null,
    data: {
      number: incidentCounter,
      title: input.title,
      severity: input.severity,
      serviceId: input.serviceId ?? null,
      tags,
      ...input.eventData,
    },
  });

  return { id: incident.id, number: incidentCounter };
}

/** The incident timeline events that automation can react to, and the trigger each one becomes. */
const INCIDENT_TRIGGER: Partial<Record<IncidentEventType, AutomationTrigger>> = {
  CREATED: 'incident.created',
  STATUS_CHANGED: 'incident.status_changed',
  SEVERITY_CHANGED: 'incident.severity_changed',
  ASSIGNED: 'incident.assigned',
};

/** The facts that only this kind of change has (what it changed from and to, who was assigned). */
function changeFacts(
  type: IncidentEventType,
  data: Prisma.InputJsonObject,
): Record<string, unknown> {
  switch (type) {
    case 'STATUS_CHANGED':
      return { fromStatus: data.from, toStatus: data.to };
    case 'SEVERITY_CHANGED':
      return { fromSeverity: data.from, toSeverity: data.to };
    case 'ASSIGNED':
      return { assigneeUserId: data.userId, assigneeName: data.name };
    default:
      return {};
  }
}

/**
 * The ONE place an incident timeline event is written, by the API and by workers alike. When the
 * event is something automation can react to, the matching domain event is written in the same
 * transaction, so "changed" and "announced" can never disagree.
 */
export async function recordIncidentEvent(
  tx: Tx,
  event: {
    organizationId: string;
    incidentId: string;
    type: IncidentEventType;
    actor: Actor;
    data: Prisma.InputJsonObject;
    /** Set when an automation execution caused this change. */
    causedByExecutionId?: string | null;
  },
) {
  const created = await tx.incidentEvent.create({
    data: {
      organizationId: event.organizationId,
      incidentId: event.incidentId,
      type: event.type,
      actorType: event.actor.type,
      actorId: event.actor.id,
      data: event.data,
    },
    select: {
      id: true,
      type: true,
      actorType: true,
      data: true,
      createdAt: true,
      actor: { select: { id: true, name: true } },
    },
  });

  const trigger = INCIDENT_TRIGGER[event.type];
  if (trigger) {
    await emitDomainEvent(tx, {
      organizationId: event.organizationId,
      type: trigger,
      subjectId: event.incidentId,
      causedByExecutionId: event.causedByExecutionId ?? null,
      facts: {
        ...(await incidentFacts(tx, event.organizationId, event.incidentId)),
        ...changeFacts(event.type, event.data),
      },
    });
  }
  return created;
}
