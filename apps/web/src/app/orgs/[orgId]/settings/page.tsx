import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { roleHasPermission } from '@nexus/shared';
import { GeneralSettingsForm } from '@/components/settings/general-form';
import { MembersPanel } from '@/components/settings/members-panel';
import { Card } from '@/components/ui/feedback';
import { getMe, getOrganization } from '@/lib/server-api';

export const metadata: Metadata = { title: 'Settings' };

export default async function SettingsPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const [org, me] = await Promise.all([getOrganization(orgId), getMe()]);
  if (!org || !me) notFound();

  // These flags only shape the UI. The API re-checks permissions on every request.
  const canEdit = roleHasPermission(org.role, 'organization.update');
  const canManageMembers = roleHasPermission(org.role, 'users.manage');

  return (
    <div className="space-y-8">
      <header className="space-y-1">
        <p className="font-mono text-xs uppercase tracking-widest text-muted">Settings</p>
        <h1 className="text-2xl font-semibold tracking-tight">Organization settings</h1>
      </header>

      <Card title="General" description="The name shown across NEXUS.">
        <GeneralSettingsForm orgId={orgId} name={org.name} slug={org.slug} canEdit={canEdit} />
      </Card>

      <Card title="Members" description="Roles control what each person can do.">
        <MembersPanel
          orgId={orgId}
          myRole={org.role}
          myUserId={me.user.id}
          canManage={canManageMembers}
        />
      </Card>
    </div>
  );
}
