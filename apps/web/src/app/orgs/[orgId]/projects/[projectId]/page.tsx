import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { roleHasPermission } from '@nexus/shared';
import { ServicesTable } from '@/components/projects/services-table';
import { getOrganization, getProject } from '@/lib/server-api';

export const metadata: Metadata = { title: 'Project' };

export default async function ProjectPage({
  params,
}: {
  params: Promise<{ orgId: string; projectId: string }>;
}) {
  const { orgId, projectId } = await params;
  const [org, project] = await Promise.all([getOrganization(orgId), getProject(orgId, projectId)]);
  if (!org || !project) notFound();

  return (
    <div className="space-y-8">
      <Link href={`/orgs/${orgId}/projects`} className="text-sm text-muted hover:text-foreground">
        ← All projects
      </Link>
      <header className="space-y-1">
        <p className="font-mono text-xs uppercase tracking-widest text-muted">Project</p>
        <h1 className="text-2xl font-semibold tracking-tight">{project.name}</h1>
        {project.description && <p className="text-sm text-muted">{project.description}</p>}
        {project.archivedAt && <p className="text-sm text-danger">This project is archived.</p>}
      </header>
      <section aria-labelledby="services-heading" className="space-y-4">
        <h2 id="services-heading" className="text-lg font-medium">
          Services
        </h2>
        <ServicesTable
          orgId={orgId}
          projectId={projectId}
          canManage={roleHasPermission(org.role, 'services.manage') && !project.archivedAt}
        />
      </section>
    </div>
  );
}
