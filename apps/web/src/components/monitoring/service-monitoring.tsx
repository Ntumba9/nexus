'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import {
  CHECK_LIMITS,
  FAILURE_REASON_LABEL,
  INCIDENT_SEVERITIES,
  SEVERITY_LABEL,
  createCheckSchema,
  type FailureReason,
  type MonitoringCheckDto,
  type MonitoringResultDto,
} from '@nexus/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import type { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Alert, Card, EmptyState, Skeleton } from '@/components/ui/feedback';
import { Field, Input, Select } from '@/components/ui/field';
import { apiFetch, describeError } from '@/lib/api-client';
import { formatDateTime, timeAgo } from '@/lib/incident-format';
import { fetchers, keys } from '@/lib/queries';
import { cn } from '@/lib/utils';

const CHECK_HEALTH_LABEL = {
  UNKNOWN: 'Not checked yet',
  HEALTHY: 'Healthy',
  DOWN: 'Down',
} as const;
const CHECK_HEALTH_STYLE = {
  UNKNOWN: 'bg-white/5 text-muted ring-white/10',
  HEALTHY: 'bg-success/10 text-success ring-success/25',
  DOWN: 'bg-danger/10 text-danger ring-danger/25',
} as const;

/** Origin and path only: the query string may hold a token, so it is never displayed. */
function displayUrl(raw: string): string {
  try {
    const url = new URL(raw);
    return `${url.origin}${url.pathname}${url.search ? '?…' : ''}`;
  } catch {
    return raw;
  }
}

export function ServiceMonitoring({
  orgId,
  serviceId,
  canManage,
}: {
  orgId: string;
  serviceId: string;
  canManage: boolean;
}) {
  const [adding, setAdding] = useState(false);
  const checks = useQuery({
    queryKey: keys.checks(orgId, serviceId),
    queryFn: () => fetchers.checks(orgId, serviceId),
    refetchInterval: 10_000, // live push updates arrive in a later phase
  });

  return (
    <div className="space-y-4">
      {checks.isPending && (
        <div aria-busy="true" aria-label="Loading checks" className="space-y-2">
          <Skeleton className="h-24" />
        </div>
      )}
      {checks.isError && (
        <div className="space-y-3">
          <Alert>{describeError(checks.error)}</Alert>
          <Button variant="secondary" size="sm" onClick={() => checks.refetch()}>
            Retry
          </Button>
        </div>
      )}
      {checks.data && checks.data.length === 0 && !adding && (
        <EmptyState
          title="This service is not monitored"
          description="Add an HTTP health check and NEXUS will test it on a schedule, track its health, and open an incident when it stays down."
        />
      )}
      {checks.data?.map((check) => (
        <CheckCard
          key={check.id}
          orgId={orgId}
          serviceId={serviceId}
          check={check}
          canManage={canManage}
        />
      ))}

      {canManage &&
        (adding ? (
          <AddCheckForm orgId={orgId} serviceId={serviceId} onDone={() => setAdding(false)} />
        ) : (
          checks.data &&
          checks.data.length < CHECK_LIMITS.maxChecksPerService && (
            <Button variant="secondary" onClick={() => setAdding(true)}>
              Add health check
            </Button>
          )
        ))}
    </div>
  );
}

function CheckCard({
  orgId,
  serviceId,
  check,
  canManage,
}: {
  orgId: string;
  serviceId: string;
  check: MonitoringCheckDto;
  canManage: boolean;
}) {
  const queryClient = useQueryClient();
  const [showResults, setShowResults] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: keys.checks(orgId, serviceId) });
    void queryClient.invalidateQueries({ queryKey: keys.results(orgId, check.id) });
    void queryClient.invalidateQueries({ queryKey: ['services', orgId] });
    void queryClient.invalidateQueries({ queryKey: keys.dashboard(orgId) });
  };

  const runNow = useMutation({
    mutationFn: () => apiFetch(`/orgs/${orgId}/checks/${check.id}/run`, { method: 'POST' }),
    onSettled: refresh,
  });
  const toggle = useMutation({
    mutationFn: () =>
      apiFetch(`/orgs/${orgId}/checks/${check.id}`, {
        method: 'PATCH',
        body: { enabled: !check.enabled },
      }),
    onSettled: refresh,
  });
  const remove = useMutation({
    mutationFn: () => apiFetch(`/orgs/${orgId}/checks/${check.id}`, { method: 'DELETE' }),
    onSettled: refresh,
  });
  const error = runNow.error ?? toggle.error ?? remove.error;

  return (
    <Card>
      <div className="space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <h3 className="font-medium">{check.name}</h3>
            <p className="break-all font-mono text-xs text-muted">
              GET {displayUrl(check.url)} → expects {check.expectedStatus}
            </p>
          </div>
          <span
            className={cn(
              'inline-flex whitespace-nowrap rounded-md px-2 py-0.5 font-mono text-[11px] ring-1 ring-inset',
              check.enabled
                ? CHECK_HEALTH_STYLE[check.healthStatus]
                : 'bg-white/5 text-muted ring-white/10',
            )}
          >
            {check.enabled ? CHECK_HEALTH_LABEL[check.healthStatus] : 'Paused'}
          </span>
        </div>

        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-xs sm:grid-cols-4">
          <Fact label="Interval" value={`${check.intervalSeconds}s`} />
          <Fact label="Timeout" value={`${check.timeoutMs} ms`} />
          <Fact
            label="Down after"
            value={`${check.failureThreshold} failure${check.failureThreshold === 1 ? '' : 's'}`}
          />
          <Fact
            label="Last checked"
            value={check.lastCheckedAt ? timeAgo(check.lastCheckedAt) : 'never'}
          />
          {check.consecutiveFailures > 0 && check.healthStatus !== 'DOWN' && (
            <Fact
              label="Failing streak"
              value={`${check.consecutiveFailures} of ${check.failureThreshold}`}
            />
          )}
          <Fact
            label="Incident"
            value={
              check.createIncidents
                ? `${SEVERITY_LABEL[check.incidentSeverity]} on outage`
                : 'not created'
            }
          />
        </dl>

        {error && <Alert>{describeError(error)}</Alert>}

        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setShowResults((v) => !v)}
            aria-expanded={showResults}
          >
            {showResults ? 'Hide results' : 'Show results'}
          </Button>
          {canManage && (
            <>
              <Button
                variant="secondary"
                size="sm"
                loading={runNow.isPending}
                disabled={!check.enabled}
                onClick={() => runNow.mutate()}
                aria-label={`Check ${check.name} now`}
              >
                Check now
              </Button>
              <Button
                variant="ghost"
                size="sm"
                loading={toggle.isPending}
                onClick={() => toggle.mutate()}
              >
                {check.enabled ? 'Pause' : 'Resume'}
              </Button>
              {confirmDelete ? (
                <span className="inline-flex items-center gap-2">
                  <span className="text-xs text-muted">Delete this check and its results?</span>
                  <Button
                    variant="danger"
                    size="sm"
                    loading={remove.isPending}
                    onClick={() => remove.mutate()}
                  >
                    Confirm
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(false)}>
                    Cancel
                  </Button>
                </span>
              ) : (
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`Delete ${check.name}`}
                  onClick={() => setConfirmDelete(true)}
                >
                  Delete
                </Button>
              )}
            </>
          )}
        </div>

        {showResults && <Results orgId={orgId} check={check} />}
      </div>
    </Card>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-muted">{label}</dt>
      <dd className="mt-0.5">{value}</dd>
    </div>
  );
}

function Results({ orgId, check }: { orgId: string; check: MonitoringCheckDto }) {
  const results = useQuery({
    queryKey: keys.results(orgId, check.id),
    queryFn: () => fetchers.results(orgId, check.id, 20),
    refetchInterval: 10_000,
  });

  if (results.isPending) return <Skeleton className="h-24" />;
  if (results.isError) {
    return (
      <div className="space-y-2">
        <Alert>{describeError(results.error)}</Alert>
        <Button variant="secondary" size="sm" onClick={() => results.refetch()}>
          Retry
        </Button>
      </div>
    );
  }
  const rows = results.data.data;
  if (rows.length === 0) {
    return (
      <EmptyState
        title="No results yet"
        description="The first result appears within a few seconds of the check being scheduled."
      />
    );
  }

  return (
    <div className="space-y-3">
      <ResponseTimeChart rows={rows} />
      <div className="overflow-x-auto">
        <table aria-label="Recent results" className="w-full text-left text-xs">
          <thead className="uppercase tracking-wider text-muted">
            <tr>
              <th scope="col" className="py-2 pr-4 font-medium">
                When
              </th>
              <th scope="col" className="py-2 pr-4 font-medium">
                Result
              </th>
              <th scope="col" className="py-2 pr-4 font-medium">
                Status
              </th>
              <th scope="col" className="py-2 pr-4 font-medium">
                Time
              </th>
              <th scope="col" className="py-2 font-medium">
                Detail
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((row) => (
              <tr key={row.id}>
                <td className="py-2 pr-4" title={formatDateTime(row.checkedAt)}>
                  {timeAgo(row.checkedAt)}
                </td>
                <td
                  className={cn(
                    'py-2 pr-4 font-mono',
                    row.status === 'UP' ? 'text-success' : 'text-danger',
                  )}
                >
                  {row.status}
                </td>
                <td className="py-2 pr-4 font-mono">{row.statusCode ?? '—'}</td>
                <td className="py-2 pr-4 font-mono">
                  {row.responseTimeMs === null ? '—' : `${row.responseTimeMs} ms`}
                </td>
                <td className="py-2 text-muted">
                  {row.failureReason
                    ? FAILURE_REASON_LABEL[row.failureReason as FailureReason]
                    : ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** Response times of the most recent results (oldest to newest); failed checks are drawn as red ticks. */
function ResponseTimeChart({ rows }: { rows: MonitoringResultDto[] }) {
  const ordered = [...rows].reverse();
  const max = Math.max(50, ...ordered.map((r) => r.responseTimeMs ?? 0));
  const width = 400;
  const height = 48;
  const slot = width / ordered.length;
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={`Response times of the last ${ordered.length} checks; failed checks are marked in red`}
      className="h-12 w-full"
    >
      {ordered.map((row, index) => {
        const x = index * slot + slot * 0.15;
        const barWidth = slot * 0.7;
        if (row.status === 'DOWN') {
          return (
            <rect
              key={row.id}
              x={x}
              y={0}
              width={barWidth}
              height={height}
              rx="2"
              className="fill-danger/40"
            />
          );
        }
        const h = Math.max(2, ((row.responseTimeMs ?? 0) / max) * (height - 4));
        return (
          <rect
            key={row.id}
            x={x}
            y={height - h}
            width={barWidth}
            height={h}
            rx="2"
            className="fill-success/60"
          />
        );
      })}
    </svg>
  );
}

type Values = z.input<typeof createCheckSchema>;

function AddCheckForm({
  orgId,
  serviceId,
  onDone,
}: {
  orgId: string;
  serviceId: string;
  onDone: () => void;
}) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    setError: setFieldError,
    formState: { errors, isSubmitting },
  } = useForm<Values, unknown, z.output<typeof createCheckSchema>>({
    resolver: zodResolver(createCheckSchema),
    defaultValues: {
      expectedStatus: 200,
      timeoutMs: 5000,
      intervalSeconds: 60,
      failureThreshold: 3,
      recoveryThreshold: 2,
      incidentSeverity: 'SEV2',
      createIncidents: true,
    },
  });

  async function onSubmit(values: z.output<typeof createCheckSchema>) {
    setError(null);
    try {
      await apiFetch(`/orgs/${orgId}/services/${serviceId}/checks`, {
        method: 'POST',
        body: values,
      });
      await queryClient.invalidateQueries({ queryKey: keys.checks(orgId, serviceId) });
      onDone();
    } catch (err) {
      const details = (err as { details?: { path: string; message: string }[] }).details ?? [];
      const urlProblem = details.find((d) => d.path === 'url');
      if (urlProblem) setFieldError('url', { message: urlProblem.message });
      else setError(describeError(err));
    }
  }

  const number = { valueAsNumber: true } as const;
  return (
    <form
      onSubmit={handleSubmit(onSubmit)}
      noValidate
      aria-label="Add a health check"
      className="space-y-4 rounded-xl border border-border bg-surface p-5"
    >
      <h3 className="text-sm font-medium">Add an HTTP health check</h3>
      {error && <Alert>{error}</Alert>}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name" htmlFor="check-name" error={errors.name?.message}>
          <Input
            id="check-name"
            placeholder="Production health endpoint"
            aria-invalid={!!errors.name}
            {...register('name')}
          />
        </Field>
        <Field
          label="URL"
          htmlFor="check-url"
          error={errors.url?.message}
          hint="Must be a public http(s) address"
        >
          <Input
            id="check-url"
            type="url"
            placeholder="https://api.example.com/health"
            aria-invalid={!!errors.url}
            {...register('url')}
          />
        </Field>
      </div>
      <details className="rounded-lg border border-border px-4 py-3">
        <summary className="cursor-pointer text-sm">
          Schedule, thresholds and incident settings
        </summary>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <Field
            label="Expected status code"
            htmlFor="check-status"
            error={errors.expectedStatus?.message}
          >
            <Input id="check-status" type="number" {...register('expectedStatus', number)} />
          </Field>
          <Field
            label="Check every (seconds)"
            htmlFor="check-interval"
            error={errors.intervalSeconds?.message}
            hint={`At least ${CHECK_LIMITS.intervalSeconds.min}`}
          >
            <Input id="check-interval" type="number" {...register('intervalSeconds', number)} />
          </Field>
          <Field label="Timeout (ms)" htmlFor="check-timeout" error={errors.timeoutMs?.message}>
            <Input id="check-timeout" type="number" {...register('timeoutMs', number)} />
          </Field>
          <Field
            label="Down after N consecutive failures"
            htmlFor="check-failures"
            error={errors.failureThreshold?.message}
            hint="1 means a single failure is enough"
          >
            <Input id="check-failures" type="number" {...register('failureThreshold', number)} />
          </Field>
          <Field
            label="Recovered after N consecutive successes"
            htmlFor="check-recovery"
            error={errors.recoveryThreshold?.message}
          >
            <Input id="check-recovery" type="number" {...register('recoveryThreshold', number)} />
          </Field>
          <Field label="Incident severity" htmlFor="check-severity">
            <Select id="check-severity" {...register('incidentSeverity')}>
              {INCIDENT_SEVERITIES.map((s) => (
                <option key={s} value={s}>
                  {SEVERITY_LABEL[s]}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <label className="mt-4 flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            {...register('createIncidents')}
            className="size-4 accent-[var(--color-accent)]"
          />
          Open an incident automatically when this check goes down
        </label>
      </details>
      <div className="flex gap-2">
        <Button type="submit" loading={isSubmitting}>
          Add check
        </Button>
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
