'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { matchLabel } from '@/components/knowledge/knowledge-panel';
import { Card, Skeleton } from '@/components/ui/feedback';
import { fetchers, keys } from '@/lib/queries';

/** Runbooks from the knowledge base that look relevant to this incident. */
export function RelatedRunbooks({
  orgId,
  incidentId,
  canWrite,
}: {
  orgId: string;
  incidentId: string;
  canWrite: boolean;
}) {
  const runbooks = useQuery({
    queryKey: keys.incidentRunbooks(orgId, incidentId),
    queryFn: () => fetchers.incidentRunbooks(orgId, incidentId),
    staleTime: 60_000,
  });

  return (
    <Card
      title="Related runbooks"
      description="Suggested from this incident’s title, service and tags."
    >
      {runbooks.isPending ? (
        <div aria-busy="true" aria-label="Finding runbooks" className="space-y-2">
          <Skeleton className="h-10" />
          <Skeleton className="h-10" />
        </div>
      ) : runbooks.isError ? (
        <p className="text-sm text-muted">Runbook suggestions are unavailable right now.</p>
      ) : runbooks.data.data.length === 0 ? (
        <p className="text-sm text-muted">
          No matching runbooks yet.{' '}
          {canWrite && (
            <Link href={`/orgs/${orgId}/knowledge/new`} className="text-accent">
              Write one
            </Link>
          )}
        </p>
      ) : (
        <ul aria-label="Related runbooks" className="space-y-3">
          {runbooks.data.data.map((hit) => (
            <li key={hit.documentId} className="space-y-0.5">
              <Link
                href={`/orgs/${orgId}/knowledge/${hit.documentId}`}
                className="text-sm font-medium hover:underline"
              >
                {hit.title}
              </Link>
              <p className="line-clamp-2 text-xs text-muted">{hit.snippet}</p>
              <p className="font-mono text-[10px] text-muted/70">{matchLabel(hit.matchedBy)}</p>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
