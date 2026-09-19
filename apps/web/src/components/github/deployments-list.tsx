'use client';

import type { DeploymentDto, DeploymentStatus } from '@nexus/shared';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Alert, EmptyState, Skeleton } from '@/components/ui/feedback';
import { describeError } from '@/lib/api-client';
import { formatDateTime, timeAgo } from '@/lib/incident-format';
import { fetchers, keys } from '@/lib/queries';
import { cn } from '@/lib/utils';

const STATUS_LABEL: Record<DeploymentStatus, string> = {
  PENDING: 'Pending',
  IN_PROGRESS: 'In progress',
  SUCCESS: 'Succeeded',
  FAILURE: 'Failed',
  INACTIVE: 'Superseded',
};
const STATUS_STYLE: Record<DeploymentStatus, string> = {
  PENDING: 'bg-white/5 text-muted ring-white/10',
  IN_PROGRESS: 'bg-accent/10 text-accent ring-accent/25',
  SUCCESS: 'bg-success/10 text-success ring-success/25',
  FAILURE: 'bg-danger/10 text-danger ring-danger/25',
  INACTIVE: 'bg-white/5 text-muted ring-white/10',
};

export function DeploymentStatusBadge({ status }: { status: DeploymentStatus }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset',
        STATUS_STYLE[status],
      )}
    >
      {STATUS_LABEL[status]}
    </span>
  );
}

export const shortSha = (sha: string): string => sha.slice(0, 7);

/** "acme/storefront@abc1234": what was deployed, at a glance. */
export function DeploymentRef({ deployment }: { deployment: DeploymentDto }) {
  return (
    <span className="font-mono text-xs">
      {deployment.repoFullName}@{shortSha(deployment.commitSha)}
    </span>
  );
}

export function DeploymentsList({
  orgId,
  serviceId,
  limit = 25,
}: {
  orgId: string;
  serviceId?: string;
  limit?: number;
}) {
  const deployments = useQuery({
    queryKey: [...keys.deployments(orgId, serviceId), limit],
    queryFn: () => fetchers.deployments(orgId, serviceId, limit),
    refetchInterval: 15_000, // live push updates arrive in a later phase
  });

  if (deployments.isPending) {
    return (
      <div aria-busy="true" aria-label="Loading deployments">
        <Skeleton className="h-24" />
      </div>
    );
  }
  if (deployments.isError) {
    return (
      <div className="space-y-3">
        <Alert>{describeError(deployments.error)}</Alert>
        <Button variant="secondary" size="sm" onClick={() => deployments.refetch()}>
          Retry
        </Button>
      </div>
    );
  }
  if (deployments.data.length === 0) {
    return (
      <EmptyState
        title="No deployments yet"
        description="Connect a GitHub repository under Integrations. Deployments appear here as GitHub reports them."
        action={
          <Link
            href={`/orgs/${orgId}/integrations`}
            className="text-sm text-accent hover:underline"
          >
            Go to integrations
          </Link>
        }
      />
    );
  }

  return (
    <div className="overflow-x-auto">
      <table aria-label="Deployments" className="w-full text-left text-sm">
        <thead className="text-xs uppercase tracking-wider text-muted">
          <tr>
            <th scope="col" className="py-2 pr-4 font-medium">
              Status
            </th>
            <th scope="col" className="py-2 pr-4 font-medium">
              Commit
            </th>
            <th scope="col" className="py-2 pr-4 font-medium">
              Environment
            </th>
            <th scope="col" className="py-2 pr-4 font-medium">
              Author
            </th>
            <th scope="col" className="py-2 font-medium">
              When
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {deployments.data.map((deployment) => (
            <tr key={deployment.id}>
              <td className="py-2 pr-4">
                <DeploymentStatusBadge status={deployment.status} />
              </td>
              <td className="py-2 pr-4">
                <DeploymentRef deployment={deployment} />
                <span className="ml-2 text-xs text-muted">{deployment.ref}</span>
              </td>
              <td className="py-2 pr-4">{deployment.environment}</td>
              <td className="py-2 pr-4 text-muted">{deployment.author ?? '—'}</td>
              <td
                className="py-2 text-muted"
                title={formatDateTime(deployment.deployedAt ?? deployment.startedAt)}
              >
                {timeAgo(deployment.deployedAt ?? deployment.startedAt)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
