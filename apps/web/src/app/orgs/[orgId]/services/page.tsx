import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { ServicesTable } from '@/components/projects/services-table';
import { getOrganization } from '@/lib/server-api';

export const metadata: Metadata = { title: 'Services' };

export default async function ServicesPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const org = await getOrganization(orgId);
  if (!org) notFound();

  return (
    <div className="space-y-8">
      <header className="space-y-1">
        <p className="font-mono text-xs uppercase tracking-widest text-muted">Services</p>
        <h1 className="text-2xl font-semibold tracking-tight">Services</h1>
        <p className="text-sm text-muted">
          Every service across your projects. Add services from a project&apos;s page.
        </p>
      </header>
      <ServicesTable orgId={orgId} canManage={false} />
    </div>
  );
}
