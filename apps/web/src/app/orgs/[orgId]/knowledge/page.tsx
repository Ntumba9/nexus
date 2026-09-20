import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { roleHasPermission } from '@nexus/shared';
import { KnowledgePanel } from '@/components/knowledge/knowledge-panel';
import { getOrganization } from '@/lib/server-api';

export const metadata: Metadata = { title: 'Knowledge' };

export default async function KnowledgePage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const org = await getOrganization(orgId);
  if (!org) notFound();

  return (
    <div className="space-y-8">
      <header className="space-y-1">
        <p className="font-mono text-xs uppercase tracking-widest text-muted">Knowledge</p>
        <h1 className="text-2xl font-semibold tracking-tight">Knowledge base</h1>
        <p className="text-sm text-muted">
          Runbooks, postmortems and how-tos. Search by keyword or by question; relevant runbooks are
          suggested on incidents.
        </p>
      </header>
      {/* UI hint only: the API refuses writes from anyone without the permission. */}
      <KnowledgePanel orgId={orgId} canManage={roleHasPermission(org.role, 'knowledge.manage')} />
    </div>
  );
}
