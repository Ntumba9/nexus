'use client';

import { INCIDENT_SEVERITIES, SEVERITY_LABEL, type DashboardDto } from '@nexus/shared';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { HealthBadge, SeverityBadge, StatusBadge } from '@/components/ui/badges';
import { Alert, Card, EmptyState, Skeleton } from '@/components/ui/feedback';
import { describeEvent, timeAgo } from '@/lib/incident-format';
import { describeError } from '@/lib/api-client';
import { fetchers, keys } from '@/lib/queries';

export function DashboardView({ orgId }: { orgId: string }) {
  const query = useQuery({
    queryKey: keys.dashboard(orgId),
    queryFn: () => fetchers.dashboard(orgId),
    refetchInterval: 30_000, // live push updates arrive in a later phase
  });

  if (query.isPending) {
    return (
      <div aria-busy="true" aria-label="Loading dashboard" className="space-y-4">
        <div className="grid gap-4 md:grid-cols-3">
          <Skeleton className="h-32" />
          <Skeleton className="h-32" />
          <Skeleton className="h-32" />
        </div>
        <Skeleton className="h-64" />
        <Skeleton className="h-64" />
      </div>
    );
  }

  if (query.isError) {
    return (
      <div className="space-y-3">
        <Alert>{describeError(query.error)}</Alert>
        <Button variant="secondary" onClick={() => query.refetch()}>
          Retry
        </Button>
      </div>
    );
  }

  const data = query.data;
  return (
    <div className="space-y-6">
      <div className="grid gap-4 md:grid-cols-3">
        <ActiveIncidentsCard data={data} orgId={orgId} />
        <ServiceHealthCard data={data} orgId={orgId} />
        <Card title="Recent deployments">
          <p className="text-sm text-muted">
            Deployments appear here once a GitHub repository is connected (coming soon).
          </p>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Active incidents" description="Most urgent first.">
          {data.activeIncidents.items.length === 0 ? (
            <EmptyState
              title="No active incidents"
              description="Everything is calm. Open an incident when something needs attention."
              action={
                <Link
                  href={`/orgs/${orgId}/incidents`}
                  className="text-sm text-accent hover:underline"
                >
                  Go to incidents
                </Link>
              }
            />
          ) : (
            <ul className="divide-y divide-border">
              {data.activeIncidents.items.map((incident) => (
                <li key={incident.id}>
                  <Link
                    href={`/orgs/${orgId}/incidents/${incident.id}`}
                    className="flex items-center justify-between gap-3 py-3 hover:bg-white/[0.02]"
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium">
                        <span className="mr-2 font-mono text-xs text-muted">
                          INC-{incident.number}
                        </span>
                        {incident.title}
                      </span>
                      <span className="text-xs text-muted">
                        {incident.service?.name ?? 'No service'} · {timeAgo(incident.createdAt)}
                      </span>
                    </span>
                    <span className="flex shrink-0 items-center gap-2">
                      <SeverityBadge severity={incident.severity} />
                      <StatusBadge status={incident.status} />
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="Incident trend" description="Opened and resolved per day (UTC), last 14 days.">
          <TrendChart points={data.incidentTrend} />
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Recent incidents">
          {data.recentIncidents.length === 0 ? (
            <EmptyState
              title="No incidents yet"
              description="Incidents you open will be listed here."
            />
          ) : (
            <ul className="divide-y divide-border">
              {data.recentIncidents.map((incident) => (
                <li key={incident.id}>
                  <Link
                    href={`/orgs/${orgId}/incidents/${incident.id}`}
                    className="flex items-center justify-between gap-3 py-2.5 hover:bg-white/[0.02]"
                  >
                    <span className="min-w-0 truncate text-sm">
                      <span className="mr-2 font-mono text-xs text-muted">
                        INC-{incident.number}
                      </span>
                      {incident.title}
                    </span>
                    <StatusBadge status={incident.status} />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="System activity" description="Latest changes across all incidents.">
          {data.recentActivity.length === 0 ? (
            <EmptyState title="No activity yet" description="Actions on incidents show up here." />
          ) : (
            <ul className="space-y-3">
              {data.recentActivity.map((event) => (
                <li key={event.id} className="text-sm">
                  <Link
                    href={`/orgs/${orgId}/incidents/${event.incidentId}`}
                    className="hover:underline"
                  >
                    <span className="font-medium">{event.actorName ?? 'System'}</span>{' '}
                    <span className="text-muted">{describeEvent(event)}</span>
                    <span className="ml-1 font-mono text-xs text-muted">
                      INC-{event.incidentNumber}
                    </span>
                  </Link>
                  <span className="block text-xs text-muted">{timeAgo(event.createdAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}

function ActiveIncidentsCard({ data, orgId }: { data: DashboardDto; orgId: string }) {
  const { total, bySeverity } = data.activeIncidents;
  return (
    <Card title="Active incidents">
      <p className="text-4xl font-semibold tabular-nums" aria-label={`${total} active incidents`}>
        {total}
      </p>
      <ul className="mt-3 flex flex-wrap gap-2" aria-label="Active incidents by severity">
        {INCIDENT_SEVERITIES.map((severity) => (
          <li key={severity} className="font-mono text-xs text-muted">
            <span className="text-foreground">{bySeverity[severity]}</span>{' '}
            {SEVERITY_LABEL[severity]}
          </li>
        ))}
      </ul>
      <Link
        href={`/orgs/${orgId}/incidents`}
        className="mt-3 inline-block text-sm text-accent hover:underline"
      >
        View all incidents →
      </Link>
    </Card>
  );
}

function ServiceHealthCard({ data, orgId }: { data: DashboardDto; orgId: string }) {
  const { total, byStatus, monitored } = data.serviceHealth;
  return (
    <Card title="Service health">
      {total === 0 ? (
        <p className="text-sm text-muted">
          No services yet.{' '}
          <Link href={`/orgs/${orgId}/projects`} className="text-accent hover:underline">
            Create a project
          </Link>{' '}
          to add one.
        </p>
      ) : (
        <>
          <p className="text-4xl font-semibold tabular-nums">{total}</p>
          <ul className="mt-3 space-y-1">
            {(['HEALTHY', 'DEGRADED', 'DOWN', 'UNKNOWN'] as const).map((status) =>
              byStatus[status] > 0 ? (
                <li key={status} className="flex items-center justify-between text-sm">
                  <HealthBadge health={status} />
                  <span className="font-mono text-xs">{byStatus[status]}</span>
                </li>
              ) : null,
            )}
          </ul>
          {!monitored && (
            <p className="mt-3 text-xs text-muted">
              Health checks are not set up yet, so services show as not monitored.
            </p>
          )}
        </>
      )}
    </Card>
  );
}

/** Grouped bars per day. An equivalent data table is provided for screen readers. */
function TrendChart({ points }: { points: DashboardDto['incidentTrend'] }) {
  const max = Math.max(1, ...points.flatMap((p) => [p.opened, p.resolved]));
  const width = 560;
  const height = 140;
  const slot = width / points.length;
  const bar = Math.max(4, slot / 2 - 3);
  const total = points.reduce((sum, p) => sum + p.opened + p.resolved, 0);

  return (
    <div>
      {total === 0 && (
        <p className="mb-2 text-xs text-muted">No incidents opened or resolved in this period.</p>
      )}
      <svg
        viewBox={`0 0 ${width} ${height + 18}`}
        role="img"
        aria-label="Bar chart of incidents opened and resolved per day over the last 14 days"
        className="w-full"
      >
        <line
          x1="0"
          x2={width}
          y1={height}
          y2={height}
          stroke="currentColor"
          className="text-border"
        />
        {points.map((point, index) => {
          const x = index * slot + slot / 2;
          const opened = (point.opened / max) * (height - 8);
          const resolved = (point.resolved / max) * (height - 8);
          return (
            <g key={point.date}>
              <title>{`${point.date}: ${point.opened} opened, ${point.resolved} resolved`}</title>
              <rect
                x={x - bar - 1}
                y={height - opened}
                width={bar}
                height={opened}
                rx="2"
                className="fill-danger/70"
              />
              <rect
                x={x + 1}
                y={height - resolved}
                width={bar}
                height={resolved}
                rx="2"
                className="fill-success/70"
              />
              {index % 3 === 0 && (
                <text x={x} y={height + 14} textAnchor="middle" className="fill-muted text-[9px]">
                  {point.date.slice(5)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      <div className="mt-2 flex gap-4 text-xs text-muted">
        <span className="flex items-center gap-1.5">
          <span aria-hidden className="size-2 rounded-sm bg-danger/70" />
          Opened
        </span>
        <span className="flex items-center gap-1.5">
          <span aria-hidden className="size-2 rounded-sm bg-success/70" />
          Resolved
        </span>
      </div>
      <table className="sr-only">
        <caption>Incidents opened and resolved per day</caption>
        <thead>
          <tr>
            <th scope="col">Date</th>
            <th scope="col">Opened</th>
            <th scope="col">Resolved</th>
          </tr>
        </thead>
        <tbody>
          {points.map((p) => (
            <tr key={p.date}>
              <td>{p.date}</td>
              <td>{p.opened}</td>
              <td>{p.resolved}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
