import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { roleHasPermission } from '@nexus/shared';
import { IncidentList } from '@/components/incidents/incident-list';
import { getOrganization } from '@/lib/server-api';

export const metadata: Metadata = { title: 'Incidents' };

export default async function IncidentsPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const org = await getOrganization(orgId);
  if (!org) notFound();

  return (
    <div className="space-y-8">
      <header className="space-y-1">
        <p className="font-mono text-xs uppercase tracking-widest text-muted">Incidents</p>
        <h1 className="text-2xl font-semibold tracking-tight">Incidents</h1>
      </header>
      <IncidentList orgId={orgId} canCreate={roleHasPermission(org.role, 'incidents.create')} />
    </div>
  );
}
