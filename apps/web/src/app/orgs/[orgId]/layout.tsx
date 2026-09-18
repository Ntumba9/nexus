import { notFound, redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { AppShell } from '@/components/shell/app-shell';
import { getMe } from '@/lib/server-api';

export default async function OrgLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = await params;
  const me = await getMe();
  if (!me) redirect('/login');

  // Memberships come from the API, which is the authority; unknown or foreign organisations 404.
  const membership = me.memberships.find((m) => m.organizationId === orgId);
  if (!membership) notFound();

  return (
    <AppShell me={me} organizationId={orgId} role={membership.role}>
      {children}
    </AppShell>
  );
}
