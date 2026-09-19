'use client';

import { AUDIT_ACTIONS } from '@nexus/shared';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Alert, EmptyState, Skeleton } from '@/components/ui/feedback';
import { Field, Select } from '@/components/ui/field';
import { describeError } from '@/lib/api-client';
import { describeAudit } from '@/lib/automation-format';
import { formatDateTime, timeAgo } from '@/lib/incident-format';
import { fetchers, keys } from '@/lib/queries';

/** The audit log: who changed what, newest first. Read-only; nothing here can edit or delete it. */
export function AuditList({ orgId }: { orgId: string }) {
  const [action, setAction] = useState('');
  const query = useInfiniteQuery({
    queryKey: keys.audit(orgId, action || undefined),
    queryFn: ({ pageParam }) => fetchers.audit(orgId, action || undefined, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextBefore ?? undefined,
  });
  const entries = query.data?.pages.flatMap((page) => page.data) ?? [];

  return (
    <div className="space-y-4">
      <div className="max-w-xs">
        <Field label="Show" htmlFor="audit-filter">
          <Select id="audit-filter" value={action} onChange={(e) => setAction(e.target.value)}>
            <option value="">Everything</option>
            {AUDIT_ACTIONS.map((value) => (
              <option key={value} value={value}>
                {describeAudit({ action: value, metadata: {} })}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      {query.isPending && (
        <div aria-busy="true" aria-label="Loading audit log">
          <Skeleton className="h-24" />
        </div>
      )}
      {query.isError && (
        <div className="space-y-3">
          <Alert>{describeError(query.error)}</Alert>
          <Button variant="secondary" size="sm" onClick={() => query.refetch()}>
            Retry
          </Button>
        </div>
      )}
      {query.data && entries.length === 0 && (
        <EmptyState
          title="Nothing recorded yet"
          description="Changes to automation rules, webhooks and integrations appear here."
        />
      )}
      {entries.length > 0 && (
        <div className="overflow-x-auto">
          <table aria-label="Audit log" className="w-full text-left text-sm">
            <thead className="text-xs uppercase tracking-wider text-muted">
              <tr>
                <th scope="col" className="py-2 pr-4 font-medium">
                  When
                </th>
                <th scope="col" className="py-2 pr-4 font-medium">
                  Who
                </th>
                <th scope="col" className="py-2 font-medium">
                  What
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {entries.map((entry) => (
                <tr key={entry.id}>
                  <td
                    className="whitespace-nowrap py-2 pr-4 text-muted"
                    title={formatDateTime(entry.createdAt)}
                  >
                    {timeAgo(entry.createdAt)}
                  </td>
                  <td className="py-2 pr-4">{entry.actorLabel}</td>
                  {/* Text only: names come from users, and React escapes them. */}
                  <td className="py-2">{describeAudit(entry)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {query.hasNextPage && (
        <Button
          variant="secondary"
          loading={query.isFetchingNextPage}
          onClick={() => query.fetchNextPage()}
        >
          Show older
        </Button>
      )}
    </div>
  );
}
