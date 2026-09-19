import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { roleHasPermission } from '@nexus/shared';
import { AuditList } from '@/components/automation/audit-list';
import { EmptyState } from '@/components/ui/feedback';
import { getOrganization } from '@/lib/server-api';

export const metadata: Metadata = { title: 'Audit log' };

export default async function AuditLogPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const org = await getOrganization(orgId);
  if (!org) notFound();

  return (
    <div className="space-y-8">
      <header className="space-y-1">
        <p className="font-mono text-xs uppercase tracking-widest text-muted">Audit log</p>
        <h1 className="text-2xl font-semibold tracking-tight">Audit log</h1>
        <p className="text-sm text-muted">
          A permanent record of who changed automation, webhooks and integrations. It cannot be
          edited or deleted.
        </p>
      </header>
      {/* UI hint only: the API refuses this for anyone without the permission. */}
      {roleHasPermission(org.role, 'audit.read') ? (
        <AuditList orgId={orgId} />
      ) : (
        <EmptyState
          title="Administrators can read the audit log"
          description="Ask an owner or admin of this organization if you need to see it."
        />
      )}
    </div>
  );
}
