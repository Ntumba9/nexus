import type {
  ActorType,
  IncidentEventType,
  IncidentSeverity,
  IncidentSource,
  Prisma,
} from '@prisma/client';

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

export function recordIncidentEvent(
  tx: Tx,
  event: {
    organizationId: string;
    incidentId: string;
    type: IncidentEventType;
    actor: Actor;
    data: Prisma.InputJsonObject;
  },
) {
  return tx.incidentEvent.create({
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
}
