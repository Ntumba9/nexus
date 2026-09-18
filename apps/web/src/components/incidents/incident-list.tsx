'use client';

import {
  ACTIVE_STATUSES,
  INCIDENT_SEVERITIES,
  INCIDENT_STATUSES,
  SEVERITY_LABEL,
  type IncidentPageDto,
} from '@nexus/shared';
import { useInfiniteQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useDeferredValue, useState } from 'react';
import { SeverityBadge, StatusBadge, TagList } from '@/components/ui/badges';
import { Button } from '@/components/ui/button';
import { Alert, EmptyState, Skeleton } from '@/components/ui/feedback';
import { Input, Select } from '@/components/ui/field';
import { describeError } from '@/lib/api-client';
import { STATUS_LABEL, timeAgo } from '@/lib/incident-format';
import { fetchers, keys } from '@/lib/queries';
import { CreateIncidentForm } from './create-incident-form';

type StatusFilter = 'active' | 'all' | (typeof INCIDENT_STATUSES)[number];

export function IncidentList({ orgId, canCreate }: { orgId: string; canCreate: boolean }) {
  const [status, setStatus] = useState<StatusFilter>('active');
  const [severity, setSeverity] = useState('');
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const q = useDeferredValue(search.trim());

  const params = new URLSearchParams({ limit: '25' });
  if (status === 'active') params.set('status', ACTIVE_STATUSES.join(','));
  else if (status !== 'all') params.set('status', status);
  if (severity) params.set('severity', severity);
  if (q) params.set('q', q);

  const incidents = useInfiniteQuery({
    queryKey: [...keys.incidents(orgId), params.toString()],
    queryFn: ({ pageParam }) => {
      const next = new URLSearchParams(params);
      if (pageParam) next.set('cursor', String(pageParam));
      return fetchers.incidentPage(orgId, next);
    },
    initialPageParam: 0,
    getNextPageParam: (last: IncidentPageDto) => last.nextCursor ?? undefined,
  });

  const rows = incidents.data?.pages.flatMap((page) => page.data) ?? [];
  const filtered = status !== 'active' || severity !== '' || q !== '';

  return (
    <div className="space-y-6">
      {canCreate &&
        (creating ? (
          <CreateIncidentForm orgId={orgId} onCancel={() => setCreating(false)} />
        ) : (
          <Button onClick={() => setCreating(true)}>Open incident</Button>
        ))}

      <div className="flex flex-col gap-3 sm:flex-row" role="search" aria-label="Filter incidents">
        <Input
          type="search"
          placeholder="Search by title or INC-number"
          aria-label="Search incidents"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="sm:max-w-xs"
        />
        <Select
          aria-label="Status"
          value={status}
          onChange={(e) => setStatus(e.target.value as StatusFilter)}
          className="sm:w-44"
        >
          <option value="active">Active</option>
          <option value="all">All statuses</option>
          {INCIDENT_STATUSES.map((s) => (
            <option key={s} value={s}>
              {STATUS_LABEL[s]}
            </option>
          ))}
        </Select>
        <Select
          aria-label="Severity"
          value={severity}
          onChange={(e) => setSeverity(e.target.value)}
          className="sm:w-40"
        >
          <option value="">All severities</option>
          {INCIDENT_SEVERITIES.map((s) => (
            <option key={s} value={s}>
              {SEVERITY_LABEL[s]}
            </option>
          ))}
        </Select>
      </div>

      {incidents.isPending && (
        <div aria-busy="true" aria-label="Loading incidents" className="space-y-2">
          <Skeleton className="h-16" />
          <Skeleton className="h-16" />
          <Skeleton className="h-16" />
        </div>
      )}

      {incidents.isError && (
        <div className="space-y-3">
          <Alert>{describeError(incidents.error)}</Alert>
          <Button variant="secondary" size="sm" onClick={() => incidents.refetch()}>
            Retry
          </Button>
        </div>
      )}

      {incidents.data && rows.length === 0 && (
        <EmptyState
          title={filtered ? 'No incidents match these filters' : 'No active incidents'}
          description={
            filtered
              ? 'Try clearing the search or changing the filters.'
              : 'Nothing needs attention right now. Open an incident when something does.'
          }
        />
      )}

      {rows.length > 0 && (
        <ul
          aria-label="Incidents"
          className="divide-y divide-border rounded-xl border border-border bg-surface"
        >
          {rows.map((incident) => (
            <li key={incident.id}>
              <Link
                href={`/orgs/${orgId}/incidents/${incident.id}`}
                className="flex flex-col gap-2 px-5 py-4 hover:bg-white/[0.02] sm:flex-row sm:items-center sm:justify-between"
              >
                <span className="min-w-0 space-y-1">
                  <span className="block truncate font-medium">
                    <span className="mr-2 font-mono text-xs text-muted">INC-{incident.number}</span>
                    {incident.title}
                  </span>
                  <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
                    <span>
                      {incident.service
                        ? `${incident.service.name} (${incident.service.environment.toLowerCase()})`
                        : 'No service'}
                    </span>
                    <span>{timeAgo(incident.createdAt)}</span>
                    {incident.assignees.length > 0 && (
                      <span>Assigned: {incident.assignees.map((a) => a.name).join(', ')}</span>
                    )}
                  </span>
                  <TagList tags={incident.tags} />
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

      {incidents.hasNextPage && (
        <Button
          variant="secondary"
          loading={incidents.isFetchingNextPage}
          onClick={() => incidents.fetchNextPage()}
        >
          Load more
        </Button>
      )}
    </div>
  );
}
