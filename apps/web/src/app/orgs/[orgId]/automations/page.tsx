import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { roleHasPermission } from '@nexus/shared';
import { RulesPanel } from '@/components/automation/rules-panel';
import { EmptyState } from '@/components/ui/feedback';
import { getOrganization } from '@/lib/server-api';

export const metadata: Metadata = { title: 'Automations' };

export default async function AutomationsPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const org = await getOrganization(orgId);
  if (!org) notFound();

  return (
    <div className="space-y-8">
      <header className="space-y-1">
        <p className="font-mono text-xs uppercase tracking-widest text-muted">Automations</p>
        <h1 className="text-2xl font-semibold tracking-tight">Automation rules</h1>
        <p className="text-sm text-muted">
          When something happens, notify people, call a webhook or open an incident. Every run is
          recorded.
        </p>
      </header>
      {/* UI hint only: the API refuses these calls for anyone without the permission. */}
      {roleHasPermission(org.role, 'automation.manage') ? (
        <RulesPanel orgId={orgId} />
      ) : (
        <EmptyState
          title="Administrators manage automations"
          description="Ask an owner or admin of this organization to set up or change rules."
        />
      )}
    </div>
  );
}
