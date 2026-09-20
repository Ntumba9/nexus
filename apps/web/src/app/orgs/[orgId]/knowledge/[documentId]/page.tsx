import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { roleHasPermission } from '@nexus/shared';
import { DocumentView } from '@/components/knowledge/document-view';
import { getOrganization } from '@/lib/server-api';

export const metadata: Metadata = { title: 'Document' };

export default async function DocumentPage({
  params,
}: {
  params: Promise<{ orgId: string; documentId: string }>;
}) {
  const { orgId, documentId } = await params;
  const org = await getOrganization(orgId);
  if (!org) notFound();
  return (
    <DocumentView
      orgId={orgId}
      documentId={documentId}
      canManage={roleHasPermission(org.role, 'knowledge.manage')}
    />
  );
}
