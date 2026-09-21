import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { roleHasPermission } from '@nexus/shared';
import { KnowledgeEditor } from '@/components/knowledge/knowledge-editor';
import { EmptyState } from '@/components/ui/feedback';
import { getOrganization } from '@/lib/server-api';

export const metadata: Metadata = { title: 'New document' };

export default async function NewDocumentPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const org = await getOrganization(orgId);
  if (!org) notFound();

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <p className="font-mono text-xs uppercase tracking-widest text-muted">Knowledge</p>
        <h1 className="text-2xl font-semibold tracking-tight">New document</h1>
      </header>
      {roleHasPermission(org.role, 'knowledge.manage') ? (
        <KnowledgeEditor orgId={orgId} />
      ) : (
        <EmptyState
          title="You can read the knowledge base, not write to it"
          description="Ask a developer or admin of this organization to add or change documents."
        />
      )}
    </div>
  );
}
