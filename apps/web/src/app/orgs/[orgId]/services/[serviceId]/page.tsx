import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { roleHasPermission } from '@nexus/shared';
import { DeploymentsList } from '@/components/github/deployments-list';
import { ServiceMonitoring } from '@/components/monitoring/service-monitoring';
import { EnvironmentBadge, HealthBadge } from '@/components/ui/badges';
import { getOrganization, getService } from '@/lib/server-api';

export const metadata: Metadata = { title: 'Service' };

export default async function ServicePage({
  params,
}: {
  params: Promise<{ orgId: string; serviceId: string }>;
}) {
  const { orgId, serviceId } = await params;
  const [org, service] = await Promise.all([getOrganization(orgId), getService(orgId, serviceId)]);
  if (!org || !service) notFound();

  return (
    <div className="space-y-8">
      <Link href={`/orgs/${orgId}/services`} className="text-sm text-muted hover:text-foreground">
        ← All services
      </Link>
      <header className="space-y-2">
        <p className="font-mono text-xs uppercase tracking-widest text-muted">Service</p>
        <h1 className="text-2xl font-semibold tracking-tight">{service.name}</h1>
        <p className="flex flex-wrap items-center gap-3 text-sm text-muted">
          <Link href={`/orgs/${orgId}/projects/${service.projectId}`} className="hover:underline">
            {service.projectName}
          </Link>
          <EnvironmentBadge environment={service.environment} />
          <HealthBadge health={service.healthStatus} />
        </p>
        {service.archivedAt && <p className="text-sm text-danger">This service is archived.</p>}
      </header>
      <section aria-labelledby="monitoring-heading" className="space-y-4">
        <h2 id="monitoring-heading" className="text-lg font-medium">
          Monitoring
        </h2>
        <ServiceMonitoring
          orgId={orgId}
          serviceId={serviceId}
          canManage={roleHasPermission(org.role, 'services.manage') && !service.archivedAt}
        />
      </section>
      <section aria-labelledby="deployments-heading" className="space-y-4">
        <h2 id="deployments-heading" className="text-lg font-medium">
          Deployments
        </h2>
        <DeploymentsList orgId={orgId} serviceId={serviceId} limit={10} />
      </section>
    </div>
  );
}
