import type { Prisma } from '@nexus/database';
import {
  allowedTransitions,
  type IncidentDetailDto,
  type IncidentEventDto,
  type IncidentEventType,
  type IncidentSummaryDto,
  type Role,
  type ActorType,
} from '@nexus/shared';

export const summarySelect = {
  id: true,
  number: true,
  title: true,
  severity: true,
  status: true,
  source: true,
  createdAt: true,
  updatedAt: true,
  acknowledgedAt: true,
  resolvedAt: true,
  service: { select: { id: true, name: true, environment: true } },
  assignments: {
    where: { unassignedAt: null },
    orderBy: { createdAt: 'asc' },
    select: { user: { select: { id: true, name: true } } },
  },
  tags: { orderBy: { tag: 'asc' }, select: { tag: true } },
} satisfies Prisma.IncidentSelect;

export const detailSelect = {
  ...summarySelect,
  description: true,
  mitigatedAt: true,
  cancelledAt: true,
  createdBy: { select: { id: true, name: true } },
} satisfies Prisma.IncidentSelect;

export const eventSelect = {
  id: true,
  type: true,
  actorType: true,
  data: true,
  createdAt: true,
  actor: { select: { id: true, name: true } },
} satisfies Prisma.IncidentEventSelect;

type SummaryRow = Prisma.IncidentGetPayload<{ select: typeof summarySelect }>;
type DetailRow = Prisma.IncidentGetPayload<{ select: typeof detailSelect }>;
type EventRow = Prisma.IncidentEventGetPayload<{ select: typeof eventSelect }>;

const iso = (date: Date | null): string | null => date?.toISOString() ?? null;

export function toSummaryDto(row: SummaryRow): IncidentSummaryDto {
  return {
    id: row.id,
    number: row.number,
    title: row.title,
    severity: row.severity,
    status: row.status,
    source: row.source,
    service: row.service,
    assignees: row.assignments.map((a) => a.user),
    tags: row.tags.map((t) => t.tag),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    acknowledgedAt: iso(row.acknowledgedAt),
    resolvedAt: iso(row.resolvedAt),
  };
}

export function toDetailDto(row: DetailRow, role: Role): IncidentDetailDto {
  return {
    ...toSummaryDto(row),
    description: row.description,
    mitigatedAt: iso(row.mitigatedAt),
    cancelledAt: iso(row.cancelledAt),
    createdBy: row.createdBy,
    allowedTransitions: allowedTransitions(row.status, role),
  };
}

export function toEventDto(row: EventRow): IncidentEventDto {
  return {
    id: row.id,
    type: row.type as IncidentEventType,
    actorType: row.actorType as ActorType,
    actor: row.actor,
    data: (row.data ?? {}) as Record<string, unknown>,
    createdAt: row.createdAt.toISOString(),
  };
}
