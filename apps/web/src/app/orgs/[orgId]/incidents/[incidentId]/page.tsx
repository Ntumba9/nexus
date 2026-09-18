import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { IncidentDetail } from '@/components/incidents/incident-detail';
import { getOrganization } from '@/lib/server-api';

export const metadata: Metadata = { title: 'Incident' };

export default async function IncidentPage({
  params,
}: {
  params: Promise<{ orgId: string; incidentId: string }>;
}) {
  const { orgId, incidentId } = await params;
  const org = await getOrganization(orgId);
  if (!org) notFound();
  return <IncidentDetail orgId={orgId} incidentId={incidentId} role={org.role} />;
}
