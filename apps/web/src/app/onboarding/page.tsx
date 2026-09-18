import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { CreateOrganizationForm } from '@/components/auth/create-org-form';
import { getMe } from '@/lib/server-api';

export const metadata: Metadata = { title: 'Create organization' };

export default async function OnboardingPage() {
  const me = await getMe();
  if (!me) redirect('/login');
  const first = me.memberships[0];

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-sm flex-col justify-center gap-8 px-6 py-12">
      <header className="space-y-2 text-center">
        <p className="font-mono text-xs tracking-[0.3em] text-accent">NEXUS</p>
        <h1 className="text-2xl font-semibold tracking-tight">
          {first ? 'Create another organization' : `Welcome, ${me.user.name.split(' ')[0]}`}
        </h1>
        <p className="text-sm text-muted">
          Organizations keep each team&apos;s services, incidents and members separate.
        </p>
      </header>
      <CreateOrganizationForm />
      {first && (
        <Link
          href={`/orgs/${first.organizationId}`}
          className="text-center text-sm text-muted hover:text-foreground"
        >
          Cancel
        </Link>
      )}
    </main>
  );
}
