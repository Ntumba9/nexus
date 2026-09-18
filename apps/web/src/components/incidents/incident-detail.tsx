'use client';

import {
  INCIDENT_SEVERITIES,
  SEVERITY_LABEL,
  roleHasPermission,
  type IncidentDetailDto,
  type IncidentEventDto,
  type IncidentSeverity,
  type IncidentStatus,
  type Role,
} from '@nexus/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { EnvironmentBadge, SeverityBadge, StatusBadge, TagList } from '@/components/ui/badges';
import { Button } from '@/components/ui/button';
import { Alert, Card, EmptyState, Skeleton } from '@/components/ui/feedback';
import { Select } from '@/components/ui/field';
import { Textarea } from '@/components/ui/textarea';
import { ApiError, apiFetch, describeError } from '@/lib/api-client';
import { actionLabel, describeEvent, formatDateTime, timeAgo } from '@/lib/incident-format';
import { fetchers, keys } from '@/lib/queries';

export function IncidentDetail({
  orgId,
  incidentId,
  role,
}: {
  orgId: string;
  incidentId: string;
  role: Role;
}) {
  const queryClient = useQueryClient();
  const canUpdate = roleHasPermission(role, 'incidents.update'); // UI hint only; the API enforces it

  const incident = useQuery({
    queryKey: keys.incident(orgId, incidentId),
    queryFn: () => fetchers.incident(orgId, incidentId),
    refetchInterval: 15_000, // live updates arrive in a later phase
  });
  const events = useQuery({
    queryKey: keys.events(orgId, incidentId),
    queryFn: () => fetchers.events(orgId, incidentId),
    refetchInterval: 15_000,
  });

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: keys.incident(orgId, incidentId) }),
      queryClient.invalidateQueries({ queryKey: keys.events(orgId, incidentId) }),
      queryClient.invalidateQueries({ queryKey: keys.incidents(orgId) }),
      queryClient.invalidateQueries({ queryKey: keys.dashboard(orgId) }),
    ]);

  if (incident.isPending) {
    return (
      <div aria-busy="true" aria-label="Loading incident" className="space-y-4">
        <Skeleton className="h-10 w-2/3" />
        <Skeleton className="h-32" />
        <Skeleton className="h-64" />
      </div>
    );
  }

  if (incident.isError) {
    const notFound = incident.error instanceof ApiError && incident.error.status === 404;
    return (
      <div className="space-y-3">
        <Alert>
          {notFound
            ? 'This incident does not exist, or you do not have access to it.'
            : describeError(incident.error)}
        </Alert>
        <div className="flex gap-3">
          {!notFound && (
            <Button variant="secondary" onClick={() => incident.refetch()}>
              Retry
            </Button>
          )}
          <Link
            href={`/orgs/${orgId}/incidents`}
            className="self-center text-sm text-accent hover:underline"
          >
            Back to incidents
          </Link>
        </div>
      </div>
    );
  }

  const data = incident.data;
  return (
    <div className="space-y-6">
      <Link href={`/orgs/${orgId}/incidents`} className="text-sm text-muted hover:text-foreground">
        ← All incidents
      </Link>

      <header className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-sm text-muted">INC-{data.number}</span>
          <SeverityBadge severity={data.severity} />
          <StatusBadge status={data.status} />
        </div>
        <h1 className="text-2xl font-semibold tracking-tight">{data.title}</h1>
        <p className="text-sm text-muted">
          Opened {formatDateTime(data.createdAt)}
          {data.createdBy ? ` by ${data.createdBy.name}` : ''}
          {data.service && (
            <>
              {' · '}
              {data.service.name} <EnvironmentBadge environment={data.service.environment} />
            </>
          )}
        </p>
        <TagList tags={data.tags} />
      </header>

      <Actions orgId={orgId} incident={data} onChanged={refresh} />

      <div className="grid gap-6 lg:grid-cols-[1fr_18rem]">
        <div className="space-y-6">
          <Card title="Description">
            {data.description ? (
              // Rendered as text: React escapes it, so incident content cannot inject markup.
              <p className="whitespace-pre-wrap text-sm">{data.description}</p>
            ) : (
              <p className="text-sm text-muted">No description provided.</p>
            )}
          </Card>

          <Card title="Timeline" description="Every change to this incident, oldest first.">
            <Timeline events={events} />
            {canUpdate && <CommentForm orgId={orgId} incidentId={incidentId} onAdded={refresh} />}
          </Card>
        </div>

        <aside className="space-y-6">
          <Card title="Details">
            <SeverityEditor
              orgId={orgId}
              incident={data}
              canUpdate={canUpdate}
              onChanged={refresh}
            />
            <dl className="mt-4 space-y-2 text-xs">
              <Fact label="Acknowledged" value={data.acknowledgedAt} />
              <Fact label="Mitigated" value={data.mitigatedAt} />
              <Fact label="Resolved" value={data.resolvedAt} />
              <Fact label="Cancelled" value={data.cancelledAt} />
            </dl>
          </Card>
          <Card title="Assignees">
            <Assignees orgId={orgId} incident={data} canUpdate={canUpdate} onChanged={refresh} />
          </Card>
        </aside>
      </div>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-muted">{label}</dt>
      <dd>{value ? formatDateTime(value) : '—'}</dd>
    </div>
  );
}

function Actions({
  orgId,
  incident,
  onChanged,
}: {
  orgId: string;
  incident: IncidentDetailDto;
  onChanged: () => Promise<unknown>;
}) {
  const [confirmCancel, setConfirmCancel] = useState(false);
  const transition = useMutation({
    mutationFn: (to: IncidentStatus) =>
      apiFetch(`/orgs/${orgId}/incidents/${incident.id}/transitions`, {
        method: 'POST',
        body: { to },
      }),
    onSettled: () => {
      setConfirmCancel(false);
      return onChanged();
    },
  });

  // The server tells us which transitions this user may perform right now.
  if (incident.allowedTransitions.length === 0) {
    return (
      <p className="text-sm text-muted">
        {incident.status === 'CANCELLED'
          ? 'This incident was cancelled and cannot be changed.'
          : 'You do not have permission to change the status of this incident.'}
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {transition.isError && <Alert>{describeError(transition.error)}</Alert>}
      <div className="flex flex-wrap gap-2" role="group" aria-label="Incident actions">
        {incident.allowedTransitions.map((to) => {
          const label = actionLabel(incident.status, to);
          if (to === 'CANCELLED') {
            return confirmCancel ? (
              <span key={to} className="inline-flex items-center gap-2">
                <span className="text-xs text-muted">Cancel this incident permanently?</span>
                <Button
                  variant="danger"
                  size="sm"
                  loading={transition.isPending}
                  onClick={() => transition.mutate(to)}
                >
                  Yes, cancel it
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setConfirmCancel(false)}>
                  Keep
                </Button>
              </span>
            ) : (
              <Button key={to} variant="danger" onClick={() => setConfirmCancel(true)}>
                {label}
              </Button>
            );
          }
          return (
            <Button
              key={to}
              variant={to === 'RESOLVED' ? 'primary' : 'secondary'}
              loading={transition.isPending && transition.variables === to}
              disabled={transition.isPending}
              onClick={() => transition.mutate(to)}
            >
              {label}
            </Button>
          );
        })}
      </div>
    </div>
  );
}

function SeverityEditor({
  orgId,
  incident,
  canUpdate,
  onChanged,
}: {
  orgId: string;
  incident: IncidentDetailDto;
  canUpdate: boolean;
  onChanged: () => Promise<unknown>;
}) {
  const change = useMutation({
    mutationFn: (severity: IncidentSeverity) =>
      apiFetch(`/orgs/${orgId}/incidents/${incident.id}`, { method: 'PATCH', body: { severity } }),
    onSettled: () => onChanged(),
  });
  return (
    <div className="space-y-2">
      <label htmlFor="severity" className="text-xs text-muted">
        Severity
      </label>
      {canUpdate ? (
        <Select
          id="severity"
          value={incident.severity}
          disabled={change.isPending}
          onChange={(e) => change.mutate(e.target.value as IncidentSeverity)}
          className="h-9 text-sm"
        >
          {INCIDENT_SEVERITIES.map((s) => (
            <option key={s} value={s}>
              {SEVERITY_LABEL[s]}
            </option>
          ))}
        </Select>
      ) : (
        <p id="severity" className="text-sm">
          {SEVERITY_LABEL[incident.severity]}
        </p>
      )}
      {change.isError && (
        <p role="alert" className="text-xs text-danger">
          {describeError(change.error)}
        </p>
      )}
    </div>
  );
}

function Assignees({
  orgId,
  incident,
  canUpdate,
  onChanged,
}: {
  orgId: string;
  incident: IncidentDetailDto;
  canUpdate: boolean;
  onChanged: () => Promise<unknown>;
}) {
  const members = useQuery({
    queryKey: keys.members(orgId),
    queryFn: () => fetchers.members(orgId),
    enabled: canUpdate,
  });
  const assign = useMutation({
    mutationFn: (userIds: string[]) =>
      apiFetch(`/orgs/${orgId}/incidents/${incident.id}/assignees`, {
        method: 'PUT',
        body: { userIds },
      }),
    onSettled: () => onChanged(),
  });
  const assignedIds = incident.assignees.map((a) => a.id);
  const candidates = (members.data ?? []).filter((m) => !assignedIds.includes(m.userId));

  return (
    <div className="space-y-3">
      {assign.isError && <Alert>{describeError(assign.error)}</Alert>}
      {incident.assignees.length === 0 ? (
        <p className="text-sm text-muted">Nobody is assigned yet.</p>
      ) : (
        <ul className="space-y-1.5">
          {incident.assignees.map((person) => (
            <li key={person.id} className="flex items-center justify-between gap-2 text-sm">
              <span className="truncate">{person.name}</span>
              {canUpdate && (
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`Unassign ${person.name}`}
                  disabled={assign.isPending}
                  onClick={() => assign.mutate(assignedIds.filter((id) => id !== person.id))}
                >
                  Remove
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {canUpdate && candidates.length > 0 && (
        <Select
          aria-label="Assign a member"
          value=""
          disabled={assign.isPending}
          onChange={(e) => e.target.value && assign.mutate([...assignedIds, e.target.value])}
          className="h-9 text-sm"
        >
          <option value="">Assign someone…</option>
          {candidates.map((member) => (
            <option key={member.userId} value={member.userId}>
              {member.name}
            </option>
          ))}
        </Select>
      )}
    </div>
  );
}

function Timeline({ events }: { events: ReturnType<typeof useQuery<IncidentEventDto[]>> }) {
  if (events.isPending) {
    return (
      <div aria-busy="true" aria-label="Loading timeline" className="space-y-3">
        <Skeleton className="h-8" />
        <Skeleton className="h-8" />
      </div>
    );
  }
  if (events.isError) {
    return (
      <div className="space-y-2">
        <Alert>{describeError(events.error)}</Alert>
        <Button variant="secondary" size="sm" onClick={() => events.refetch()}>
          Retry
        </Button>
      </div>
    );
  }
  if (events.data.length === 0) {
    return (
      <EmptyState title="No events yet" description="Changes to this incident will appear here." />
    );
  }
  return (
    <ol aria-label="Incident timeline" className="space-y-4">
      {events.data.map((event) => (
        <li key={event.id} className="flex gap-3">
          <span aria-hidden className="mt-1.5 size-2 shrink-0 rounded-full bg-accent/60" />
          <div className="min-w-0 flex-1 space-y-1">
            <p className="text-sm">
              <span className="font-medium">{event.actor?.name ?? 'System'}</span>{' '}
              <span className="text-muted">{describeEvent(event)}</span>
            </p>
            {event.type === 'COMMENT_ADDED' && typeof event.data.body === 'string' && (
              <p className="whitespace-pre-wrap rounded-lg border border-border bg-background px-3 py-2 text-sm">
                {event.data.body}
              </p>
            )}
            {event.type === 'STATUS_CHANGED' && typeof event.data.note === 'string' && (
              <p className="text-sm italic text-muted">“{event.data.note}”</p>
            )}
            <time
              dateTime={event.createdAt}
              title={formatDateTime(event.createdAt)}
              className="block text-xs text-muted"
            >
              {timeAgo(event.createdAt)}
            </time>
          </div>
        </li>
      ))}
    </ol>
  );
}

function CommentForm({
  orgId,
  incidentId,
  onAdded,
}: {
  orgId: string;
  incidentId: string;
  onAdded: () => Promise<unknown>;
}) {
  const [body, setBody] = useState('');
  const add = useMutation({
    mutationFn: (text: string) =>
      apiFetch(`/orgs/${orgId}/incidents/${incidentId}/comments`, {
        method: 'POST',
        body: { body: text },
      }),
    onSuccess: () => setBody(''),
    onSettled: () => onAdded(),
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    if (body.trim()) add.mutate(body.trim());
  }

  return (
    <form onSubmit={submit} className="mt-6 space-y-2 border-t border-border pt-5">
      <label htmlFor="comment" className="text-sm font-medium">
        Add a comment
      </label>
      {add.isError && <Alert>{describeError(add.error)}</Alert>}
      <Textarea
        id="comment"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder="What did you find or do?"
        maxLength={5000}
      />
      <Button type="submit" loading={add.isPending} disabled={!body.trim()}>
        Comment
      </Button>
    </form>
  );
}
