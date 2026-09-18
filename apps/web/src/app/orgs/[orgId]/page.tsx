import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { DashboardView } from '@/components/dashboard/dashboard-view';
import { getOrganization } from '@/lib/server-api';

export const metadata: Metadata = { title: 'Overview' };

export default async function OverviewPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const org = await getOrganization(orgId);
  if (!org) notFound();

  return (
    <div className="space-y-8">
      <header className="space-y-1">
        <p className="font-mono text-xs uppercase tracking-widest text-muted">Overview</p>
        <h1 className="text-2xl font-semibold tracking-tight">{org.name}</h1>
        <p className="text-sm text-muted">You are {org.role.toLowerCase()} in this organization.</p>
      </header>
      <DashboardView orgId={orgId} />
    </div>
  );
}
