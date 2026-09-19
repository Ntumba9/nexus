'use client';

import {
  TRIGGER_LABEL,
  type AutomationExecutionDto,
  type AutomationRuleDto,
  type OutboundWebhookDto,
} from '@nexus/shared';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Alert, Card, EmptyState, Skeleton } from '@/components/ui/feedback';
import { apiFetch, describeError } from '@/lib/api-client';
import {
  EXECUTION_STATUS_LABEL,
  EXECUTION_STATUS_STYLE,
  SKIP_REASON_LABEL,
  describeAction,
  describeCondition,
} from '@/lib/automation-format';
import { formatDateTime, timeAgo } from '@/lib/incident-format';
import { fetchers, keys } from '@/lib/queries';
import { cn } from '@/lib/utils';
import { RuleForm } from './rule-form';

export function ExecutionBadge({ status }: { status: AutomationExecutionDto['status'] }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset',
        EXECUTION_STATUS_STYLE[status],
      )}
    >
      {EXECUTION_STATUS_LABEL[status]}
    </span>
  );
}

export function RulesPanel({ orgId }: { orgId: string }) {
  const [editing, setEditing] = useState<'new' | string | null>(null);
  const rules = useQuery({
    queryKey: keys.rules(orgId),
    queryFn: () => fetchers.rules(orgId),
    refetchInterval: 15_000,
  });
  const webhooks = useQuery({
    queryKey: keys.webhooks(orgId),
    queryFn: () => fetchers.webhooks(orgId),
  });
  const webhookList = webhooks.data ?? [];
  const webhookNames = new Map(webhookList.map((webhook) => [webhook.id, webhook.name]));

  return (
    <div className="space-y-6">
      {editing === 'new' ? (
        <Card
          title="New rule"
          description="A rule reacts to something that happens and then does what you choose."
        >
          <RuleForm orgId={orgId} webhooks={webhookList} onDone={() => setEditing(null)} />
        </Card>
      ) : (
        <div>
          <Button onClick={() => setEditing('new')}>New rule</Button>
        </div>
      )}

      {rules.isPending && (
        <div aria-busy="true" aria-label="Loading rules">
          <Skeleton className="h-24" />
        </div>
      )}
      {rules.isError && (
        <div className="space-y-3">
          <Alert>{describeError(rules.error)}</Alert>
          <Button variant="secondary" size="sm" onClick={() => rules.refetch()}>
            Retry
          </Button>
        </div>
      )}
      {rules.data && rules.data.length === 0 && editing !== 'new' && (
        <EmptyState
          title="No automation rules yet"
          description="Create one to be notified, call a webhook or open an incident when something happens. A template is the quickest start."
        />
      )}
      {rules.data && rules.data.length > 0 && (
        <ul aria-label="Automation rules" className="space-y-4">
          {rules.data.map((rule) => (
            <li key={rule.id}>
              {editing === rule.id ? (
                <Card title={`Edit “${rule.name}”`}>
                  <RuleForm
                    orgId={orgId}
                    rule={rule}
                    webhooks={webhookList}
                    onDone={() => setEditing(null)}
                  />
                </Card>
              ) : (
                <RuleCard
                  orgId={orgId}
                  rule={rule}
                  webhookNames={webhookNames}
                  onEdit={() => setEditing(rule.id)}
                />
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function RuleCard({
  orgId,
  rule,
  webhookNames,
  onEdit,
}: {
  orgId: string;
  rule: AutomationRuleDto;
  webhookNames: ReadonlyMap<string, string>;
  onEdit: () => void;
}) {
  const queryClient = useQueryClient();
  const [showRuns, setShowRuns] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const refresh = () => queryClient.invalidateQueries({ queryKey: keys.rules(orgId) });

  const toggle = useMutation({
    mutationFn: () =>
      apiFetch(`/orgs/${orgId}/automation/rules/${rule.id}`, {
        method: 'PATCH',
        body: { enabled: !rule.enabled },
      }),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: () => apiFetch(`/orgs/${orgId}/automation/rules/${rule.id}`, { method: 'DELETE' }),
    onSuccess: refresh,
  });

  return (
    <div className="space-y-3 rounded-xl border border-border bg-surface p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h3 className="text-base font-medium">{rule.name}</h3>
          <p className="text-sm text-muted">
            When: {TRIGGER_LABEL[rule.trigger]}
            {rule.conditions.length > 0 && (
              <>
                {' · only when '}
                {rule.conditions
                  .map((condition) => describeCondition(rule.trigger, condition))
                  .join(' and ')}
              </>
            )}
          </p>
        </div>
        <span
          className={cn(
            'rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset',
            rule.enabled
              ? 'bg-success/10 text-success ring-success/25'
              : 'bg-white/5 text-muted ring-white/10',
          )}
        >
          {rule.enabled ? 'On' : 'Off'}
        </span>
      </div>

      <ul className="list-disc space-y-0.5 pl-5 text-sm">
        {rule.actions.map((action, index) => (
          <li key={index}>{describeAction(action, webhookNames)}</li>
        ))}
      </ul>

      <p className="text-xs text-muted">
        {rule.lastExecutionAt ? (
          <>
            Last ran{' '}
            <span title={formatDateTime(rule.lastExecutionAt)}>
              {timeAgo(rule.lastExecutionAt)}
            </span>
            {rule.lastExecutionStatus && (
              <>
                {' · '}
                {EXECUTION_STATUS_LABEL[rule.lastExecutionStatus]}
              </>
            )}
          </>
        ) : (
          'Has not run yet'
        )}
      </p>

      {(toggle.isError || remove.isError) && (
        <Alert>{describeError(toggle.error ?? remove.error)}</Alert>
      )}

      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="secondary"
          loading={toggle.isPending}
          onClick={() => toggle.mutate()}
        >
          {rule.enabled ? 'Turn off' : 'Turn on'}
        </Button>
        <Button size="sm" variant="secondary" onClick={onEdit}>
          Edit
        </Button>
        <Button
          size="sm"
          variant="ghost"
          aria-expanded={showRuns}
          onClick={() => setShowRuns((v) => !v)}
        >
          {showRuns ? 'Hide runs' : 'Show runs'}
        </Button>
        {confirming ? (
          <span className="flex items-center gap-2 text-sm">
            <span className="text-muted">Delete this rule and its run history?</span>
            <Button
              size="sm"
              variant="danger"
              loading={remove.isPending}
              onClick={() => remove.mutate()}
            >
              Delete rule
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </span>
        ) : (
          <Button size="sm" variant="ghost" onClick={() => setConfirming(true)}>
            Delete
          </Button>
        )}
      </div>

      {showRuns && <Executions orgId={orgId} ruleId={rule.id} ruleName={rule.name} />}
    </div>
  );
}

function Executions({
  orgId,
  ruleId,
  ruleName,
}: {
  orgId: string;
  ruleId: string;
  ruleName: string;
}) {
  const query = useInfiniteQuery({
    queryKey: keys.executions(orgId, ruleId),
    queryFn: ({ pageParam }) => fetchers.executions(orgId, ruleId, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextBefore ?? undefined,
    refetchInterval: 15_000,
  });

  if (query.isPending) return <Skeleton className="h-16" />;
  if (query.isError) return <Alert>{describeError(query.error)}</Alert>;
  const runs = query.data.pages.flatMap((page) => page.data);
  if (runs.length === 0) {
    return <p className="text-sm text-muted">This rule has not matched anything yet.</p>;
  }

  return (
    <div className="space-y-3">
      <ul
        aria-label={`Runs of ${ruleName}`}
        className="divide-y divide-border rounded-lg border border-border"
      >
        {runs.map((run) => (
          <li key={run.id} className="space-y-1 px-3 py-2 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <ExecutionBadge status={run.status} />
              <span className="text-xs text-muted" title={formatDateTime(run.createdAt)}>
                {timeAgo(run.createdAt)}
              </span>
              <span className="text-xs text-muted">{TRIGGER_LABEL[run.eventType]}</span>
            </div>
            {run.skipReason && (
              <p className="text-xs text-muted">{SKIP_REASON_LABEL[run.skipReason]}</p>
            )}
            {run.results.length > 0 && (
              <ul className="space-y-0.5 text-xs text-muted">
                {run.results.map((result) => (
                  <li key={result.index}>
                    <span className="font-mono">{result.type}</span>: {result.detail}
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
      {query.hasNextPage && (
        <Button
          size="sm"
          variant="secondary"
          loading={query.isFetchingNextPage}
          onClick={() => query.fetchNextPage()}
        >
          Show older runs
        </Button>
      )}
    </div>
  );
}

export type { OutboundWebhookDto };
