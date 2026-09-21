'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { DeploymentRef, DeploymentStatusBadge } from '@/components/github/deployments-list';
import { Card, Skeleton } from '@/components/ui/feedback';
import { timeAgo } from '@/lib/incident-format';
import { fetchers } from '@/lib/queries';
import { pollEvery } from '@/lib/realtime';

const SHOWN = 3;

/**
 * The latest deployments GitHub has reported. It asks the deployments endpoint itself (the dashboard
 * payload does not carry them), under its own query key so it never mixes with the full list's cache.
 */
export function RecentDeploymentsCard({ orgId }: { orgId: string }) {
  const query = useQuery({
    queryKey: ['dashboard-deployments', orgId],
    queryFn: () => fetchers.deployments(orgId, undefined, SHOWN),
    refetchInterval: pollEvery(30_000),
  });

  return (
    <Card title="Recent deployments">
      {query.isPending ? (
        <Skeleton className="h-16" aria-label="Loading deployments" />
      ) : query.isError ? (
        <p className="text-sm text-muted">Deployments could not be loaded.</p>
      ) : query.data.length === 0 ? (
        <p className="text-sm text-muted">
          No deployments yet. Connect a GitHub repository under{' '}
          <Link href={`/orgs/${orgId}/integrations`} className="text-accent hover:underline">
            Integrations
          </Link>{' '}
          and they appear here.
        </p>
      ) : (
        <div className="space-y-3">
          <ul className="space-y-2">
            {query.data.slice(0, SHOWN).map((deployment) => (
              <li key={deployment.id} className="flex items-center justify-between gap-3 text-sm">
                <span className="min-w-0 truncate">
                  <DeploymentRef deployment={deployment} />
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  <DeploymentStatusBadge status={deployment.status} />
                  <span className="text-xs text-muted">
                    {timeAgo(deployment.deployedAt ?? deployment.startedAt)}
                  </span>
                </span>
              </li>
            ))}
          </ul>
          <Link href={`/orgs/${orgId}/deployments`} className="text-sm text-accent hover:underline">
            View all deployments →
          </Link>
        </div>
      )}
    </Card>
  );
}
