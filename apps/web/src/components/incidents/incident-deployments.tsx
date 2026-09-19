'use client';

import type { DeploymentDto, DeploymentRelation } from '@nexus/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DeploymentRef, DeploymentStatusBadge } from '@/components/github/deployments-list';
import { Button } from '@/components/ui/button';
import { Alert, Skeleton } from '@/components/ui/feedback';
import { apiFetch, describeError } from '@/lib/api-client';
import { formatDateTime, timeAgo } from '@/lib/incident-format';
import { fetchers, keys } from '@/lib/queries';
import { pollEvery } from '@/lib/realtime';

const RELATION_LABEL: Record<DeploymentRelation, string> = {
  SUSPECTED: 'Suspected cause',
  CONFIRMED: 'Confirmed cause',
};

function When({ deployment }: { deployment: DeploymentDto }) {
  const at = deployment.deployedAt ?? deployment.startedAt;
  return <span title={formatDateTime(at)}>{timeAgo(at)}</span>;
}

export function IncidentDeployments({
  orgId,
  incidentId,
  canUpdate,
  onChanged,
}: {
  orgId: string;
  incidentId: string;
  canUpdate: boolean;
  onChanged: () => unknown;
}) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: keys.incidentDeployments(orgId, incidentId),
    queryFn: () => fetchers.incidentDeployments(orgId, incidentId),
    refetchInterval: pollEvery(30_000),
  });

  const link = useMutation({
    mutationFn: (input: { deploymentId: string; relation: DeploymentRelation }) =>
      apiFetch(`/orgs/${orgId}/incidents/${incidentId}/deployments`, {
        method: 'POST',
        body: input,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: keys.incidentDeployments(orgId, incidentId),
      });
      await onChanged(); // the link is also recorded on the timeline
    },
  });

  if (query.isPending) {
    return (
      <div aria-busy="true" aria-label="Loading deployments">
        <Skeleton className="h-16" />
      </div>
    );
  }
  if (query.isError) {
    return <Alert>{describeError(query.error)}</Alert>;
  }

  const { linked, suggested } = query.data;
  return (
    <div className="space-y-4">
      {link.isError && <Alert>{describeError(link.error)}</Alert>}

      {linked.length > 0 && (
        <ul aria-label="Linked deployments" className="space-y-2">
          {linked.map(({ deployment, relation }) => (
            <li
              key={deployment.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border px-3 py-2"
            >
              <span className="flex flex-wrap items-center gap-2">
                <DeploymentStatusBadge status={deployment.status} />
                <DeploymentRef deployment={deployment} />
                <span className="text-xs text-muted">{deployment.environment}</span>
              </span>
              <span className="flex items-center gap-3 text-xs text-muted">
                <span className={relation === 'CONFIRMED' ? 'text-danger' : undefined}>
                  {RELATION_LABEL[relation]}
                </span>
                <When deployment={deployment} />
              </span>
            </li>
          ))}
        </ul>
      )}

      {suggested.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-medium uppercase tracking-wider text-muted">Possible causes</p>
          <ul aria-label="Suggested deployments" className="space-y-2">
            {suggested.map((deployment) => (
              <li
                key={deployment.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-dashed border-border px-3 py-2"
              >
                <span className="flex flex-wrap items-center gap-2">
                  <DeploymentRef deployment={deployment} />
                  <span className="text-xs text-muted">
                    {deployment.environment} · <When deployment={deployment} />
                    {deployment.author ? ` · ${deployment.author}` : ''}
                  </span>
                </span>
                {canUpdate && (
                  <span className="flex gap-2">
                    <Button
                      size="sm"
                      variant="secondary"
                      loading={link.isPending}
                      onClick={() =>
                        link.mutate({ deploymentId: deployment.id, relation: 'SUSPECTED' })
                      }
                    >
                      Link
                    </Button>
                    <Button
                      size="sm"
                      variant="danger"
                      loading={link.isPending}
                      onClick={() =>
                        link.mutate({ deploymentId: deployment.id, relation: 'CONFIRMED' })
                      }
                    >
                      Confirm as cause
                    </Button>
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {linked.length === 0 && suggested.length === 0 && (
        <p className="text-sm text-muted">
          No deployments to this service in the two hours before the incident began, and none
          linked.
        </p>
      )}
    </div>
  );
}
