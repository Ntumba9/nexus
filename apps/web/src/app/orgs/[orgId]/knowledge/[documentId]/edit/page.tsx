import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { roleHasPermission } from '@nexus/shared';
import { DocumentView } from '@/components/knowledge/document-view';
import { EmptyState } from '@/components/ui/feedback';
import { getOrganization } from '@/lib/server-api';

export const metadata: Metadata = { title: 'Edit document' };

export default async function EditDocumentPage({
  params,
}: {
  params: Promise<{ orgId: string; documentId: string }>;
}) {
  const { orgId, documentId } = await params;
  const org = await getOrganization(orgId);
  if (!org) notFound();
  if (!roleHasPermission(org.role, 'knowledge.manage')) {
    return (
      <EmptyState
        title="You can read this document, not edit it"
        description="Ask a developer or admin of this organization to make changes."
      />
    );
  }
  return <DocumentView orgId={orgId} documentId={documentId} canManage editing />;
}
