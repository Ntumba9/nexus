import type { MeResponse, Role } from '@nexus/shared';
import type { ReactNode } from 'react';
import { Nav } from './nav';
import { OrgSwitcher } from './org-switcher';
import { UserMenu } from './user-menu';

/** The authenticated frame: top bar (organisation switcher, account menu) + primary navigation. */
export function AppShell({
  me,
  organizationId,
  role,
  children,
}: {
  me: MeResponse;
  organizationId: string;
  role: Role;
  children: ReactNode;
}) {
  return (
    <div className="min-h-screen">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-50 focus:rounded-lg focus:bg-accent focus:px-3 focus:py-2 focus:text-background"
      >
        Skip to content
      </a>
      <header className="sticky top-0 z-10 flex h-14 items-center justify-between border-b border-border bg-background/80 px-4 backdrop-blur">
        <div className="flex items-center gap-4">
          <span className="font-mono text-xs tracking-[0.3em] text-accent">NEXUS</span>
          <OrgSwitcher memberships={me.memberships} currentId={organizationId} />
        </div>
        <UserMenu user={me.user} />
      </header>
      <div className="md:grid md:grid-cols-[14rem_1fr]">
        <aside className="border-b border-border p-2 md:sticky md:top-14 md:h-[calc(100vh-3.5rem)] md:border-b-0 md:border-r md:p-3">
          <Nav orgId={organizationId} role={role} />
        </aside>
        <main id="main" className="mx-auto w-full max-w-5xl px-4 py-8 md:px-8">
          {children}
        </main>
      </div>
    </div>
  );
}
