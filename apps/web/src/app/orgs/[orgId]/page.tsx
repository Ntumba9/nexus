import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { permissionsForRole } from '@nexus/shared';
import { Card, EmptyState } from '@/components/ui/feedback';
import { getOrganization } from '@/lib/server-api';

export const metadata: Metadata = { title: 'Overview' };

export default async function OverviewPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const org = await getOrganization(orgId);
  if (!org) notFound();
  const permissions = permissionsForRole(org.role);

  return (
    <div className="space-y-8">
      <header className="space-y-1">
        <p className="font-mono text-xs uppercase tracking-widest text-muted">Overview</p>
        <h1 className="text-2xl font-semibold tracking-tight">{org.name}</h1>
      </header>

      <div className="grid gap-4 md:grid-cols-2">
        <Card
          title="Your access"
          description={`You are ${org.role.toLowerCase()} in this organization.`}
        >
          <ul aria-label="Your permissions" className="flex flex-wrap gap-1.5">
            {permissions.map((permission) => (
              <li
                key={permission}
                className="rounded-md bg-white/5 px-2 py-1 font-mono text-[11px] text-muted"
              >
                {permission}
              </li>
            ))}
          </ul>
        </Card>
        <Card title="Team" description="People who can access this organization.">
          <Link href={`/orgs/${orgId}/settings`} className="text-sm text-accent hover:underline">
            View members &amp; roles →
          </Link>
        </Card>
      </div>

      <EmptyState
        title="No services or incidents yet"
        description="Service monitoring and incident management arrive in the next phases. Once they do, your service health and active incidents will appear here."
      />
    </div>
  );
}
