import { Inject, Injectable } from '@nestjs/common';
import type { PrismaClient } from '@nexus/database';
import {
  ACTIVE_STATUSES,
  INCIDENT_SEVERITIES,
  SERVICE_HEALTH,
  type DashboardDto,
  type DashboardTrendPointDto,
  type IncidentEventType,
  type IncidentSeverity,
  type ServiceHealth,
} from '@nexus/shared';
import type { TenantContext } from '../common/request-context';
import { PRISMA } from '../infrastructure/tokens';
import { summarySelect, toSummaryDto } from './incident-mapper';

const TREND_DAYS = 14;
const DAY_MS = 86_400_000;

interface DayCount {
  day: string;
  count: bigint;
}

/** Aggregates for the overview page. Every query is scoped to the caller's organisation. */
@Injectable()
export class DashboardService {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async get(tenant: TenantContext, now: Date = new Date()): Promise<DashboardDto> {
    const organizationId = tenant.organizationId;
    const active = { organizationId, status: { in: [...ACTIVE_STATUSES] } };

    const [severityGroups, activeItems, recent, healthGroups, opened, resolved, activity] =
      await Promise.all([
        this.prisma.incident.groupBy({ by: ['severity'], where: active, _count: { _all: true } }),
        this.prisma.incident.findMany({
          where: active,
          orderBy: [{ severity: 'asc' }, { createdAt: 'asc' }],
          take: 5,
          select: summarySelect,
        }),
        this.prisma.incident.findMany({
          where: { organizationId },
          orderBy: { number: 'desc' },
          take: 10,
          select: summarySelect,
        }),
        this.prisma.service.groupBy({
          by: ['healthStatus'],
          where: { organizationId, archivedAt: null },
          _count: { _all: true },
        }),
        this.dailyCounts(organizationId, 'createdAt', now),
        this.dailyCounts(organizationId, 'resolvedAt', now),
        this.prisma.incidentEvent.findMany({
          where: { organizationId },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: 10,
          select: {
            id: true,
            type: true,
            data: true,
            createdAt: true,
            actor: { select: { name: true } },
            incident: { select: { id: true, number: true, title: true } },
          },
        }),
      ]);

    const bySeverity = Object.fromEntries(INCIDENT_SEVERITIES.map((s) => [s, 0])) as Record<
      IncidentSeverity,
      number
    >;
    for (const group of severityGroups) bySeverity[group.severity] = group._count._all;

    const byStatus = Object.fromEntries(SERVICE_HEALTH.map((s) => [s, 0])) as Record<
      ServiceHealth,
      number
    >;
    for (const group of healthGroups) byStatus[group.healthStatus] = group._count._all;

    return {
      activeIncidents: {
        total: Object.values(bySeverity).reduce((sum, n) => sum + n, 0),
        bySeverity,
        items: activeItems.map(toSummaryDto),
      },
      recentIncidents: recent.map(toSummaryDto),
      serviceHealth: {
        total: Object.values(byStatus).reduce((sum, n) => sum + n, 0),
        byStatus,
        // No monitoring exists yet (Phase 4); UNKNOWN must not be presented as healthy.
        monitored: byStatus.HEALTHY + byStatus.DEGRADED + byStatus.DOWN > 0,
      },
      recentDeployments: { available: false, items: [] },
      incidentTrend: buildTrend(opened, resolved, now),
      recentActivity: activity.map((event) => ({
        id: event.id,
        type: event.type as IncidentEventType,
        incidentId: event.incident.id,
        incidentNumber: event.incident.number,
        incidentTitle: event.incident.title,
        actorName: event.actor?.name ?? null,
        data: (event.data ?? {}) as Record<string, unknown>,
        createdAt: event.createdAt.toISOString(),
      })),
    };
  }

  /** Incidents per UTC day over the trend window, by the given timestamp column. */
  private dailyCounts(
    organizationId: string,
    column: 'createdAt' | 'resolvedAt',
    now: Date,
  ): Promise<DayCount[]> {
    const since = new Date(startOfUtcDay(now).getTime() - (TREND_DAYS - 1) * DAY_MS);
    // The column name is chosen from a fixed union above, never from user input.
    return column === 'createdAt'
      ? this.prisma.$queryRaw<DayCount[]>`
          SELECT to_char(("createdAt" AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') AS day, count(*)::bigint AS count
          FROM "Incident"
          WHERE "organizationId" = ${organizationId}::uuid AND "createdAt" >= ${since}
          GROUP BY 1`
      : this.prisma.$queryRaw<DayCount[]>`
          SELECT to_char(("resolvedAt" AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') AS day, count(*)::bigint AS count
          FROM "Incident"
          WHERE "organizationId" = ${organizationId}::uuid AND "resolvedAt" >= ${since}
          GROUP BY 1`;
  }
}

function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

/** Zero-filled, oldest-first series so charts never have gaps. Exported for unit testing. */
export function buildTrend(
  opened: DayCount[],
  resolved: DayCount[],
  now: Date,
): DashboardTrendPointDto[] {
  const openedByDay = new Map(opened.map((row) => [row.day, Number(row.count)]));
  const resolvedByDay = new Map(resolved.map((row) => [row.day, Number(row.count)]));
  const today = startOfUtcDay(now).getTime();
  return Array.from({ length: TREND_DAYS }, (_, index) => {
    const date = new Date(today - (TREND_DAYS - 1 - index) * DAY_MS).toISOString().slice(0, 10);
    return { date, opened: openedByDay.get(date) ?? 0, resolved: resolvedByDay.get(date) ?? 0 };
  });
}
