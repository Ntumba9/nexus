import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { NotificationsList } from '@/components/notifications/notifications-list';
import { getOrganization } from '@/lib/server-api';

export const metadata: Metadata = { title: 'Notifications' };

export default async function NotificationsPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = await params;
  const org = await getOrganization(orgId);
  if (!org) notFound();

  return (
    <div className="space-y-8">
      <header className="space-y-1">
        <p className="font-mono text-xs uppercase tracking-widest text-muted">Notifications</p>
        <h1 className="text-2xl font-semibold tracking-tight">Your notifications</h1>
        <p className="text-sm text-muted">Only you can see these.</p>
      </header>
      <NotificationsList orgId={orgId} />
    </div>
  );
}
