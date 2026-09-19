import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { roleHasPermission } from '@nexus/shared';
import { OutboundWebhooksPanel } from '@/components/automation/webhooks-panel';
import { IntegrationsPanel } from '@/components/github/integrations-panel';
import { EmptyState } from '@/components/ui/feedback';
import { getOrganization } from '@/lib/server-api';

export const metadata: Metadata = { title: 'Integrations' };

export default async function IntegrationsPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const org = await getOrganization(orgId);
  if (!org) notFound();

  return (
    <div className="space-y-8">
      <header className="space-y-1">
        <p className="font-mono text-xs uppercase tracking-widest text-muted">Integrations</p>
        <h1 className="text-2xl font-semibold tracking-tight">GitHub</h1>
      </header>
      {/* UI hint only: the API refuses these calls for anyone without the permission. */}
      {roleHasPermission(org.role, 'integrations.manage') ? (
        <div className="space-y-8">
          <IntegrationsPanel orgId={orgId} />
          <OutboundWebhooksPanel orgId={orgId} />
        </div>
      ) : (
        <EmptyState
          title="Administrators manage integrations"
          description="Ask an owner or admin of this organization to connect a repository."
        />
      )}
    </div>
  );
}
