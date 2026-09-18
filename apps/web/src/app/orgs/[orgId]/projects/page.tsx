import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { roleHasPermission } from '@nexus/shared';
import { ProjectsView } from '@/components/projects/projects-view';
import { getOrganization } from '@/lib/server-api';

export const metadata: Metadata = { title: 'Projects' };

export default async function ProjectsPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const org = await getOrganization(orgId);
  if (!org) notFound();

  return (
    <div className="space-y-8">
      <header className="space-y-1">
        <p className="font-mono text-xs uppercase tracking-widest text-muted">Projects</p>
        <h1 className="text-2xl font-semibold tracking-tight">Projects</h1>
      </header>
      <ProjectsView orgId={orgId} canManage={roleHasPermission(org.role, 'projects.manage')} />
    </div>
  );
}
