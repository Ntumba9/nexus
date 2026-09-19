import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { DeploymentsList } from '@/components/github/deployments-list';
import { Card } from '@/components/ui/feedback';
import { getOrganization } from '@/lib/server-api';

export const metadata: Metadata = { title: 'Deployments' };

export default async function DeploymentsPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const org = await getOrganization(orgId);
  if (!org) notFound();

  return (
    <div className="space-y-8">
      <header className="space-y-1">
        <p className="font-mono text-xs uppercase tracking-widest text-muted">Deployments</p>
        <h1 className="text-2xl font-semibold tracking-tight">Recent deployments</h1>
      </header>
      <Card description="Reported by GitHub for the repositories connected under Integrations.">
        <DeploymentsList orgId={orgId} limit={50} />
      </Card>
    </div>
  );
}
