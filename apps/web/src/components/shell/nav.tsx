'use client';

import { roleHasPermission, type Permission, type Role } from '@nexus/shared';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';

interface NavItem {
  label: string;
  /** Path below /orgs/:orgId; undefined means the feature is not built yet. */
  path?: string;
  /** Hide the item from roles without this permission. UX only: the API enforces access. */
  permission?: Permission;
  soon?: string;
}

const NAV: NavItem[] = [
  { label: 'Overview', path: '' },
  { label: 'Incidents', path: '/incidents' },
  { label: 'Services', path: '/services' },
  { label: 'Projects', path: '/projects' },
  { label: 'Deployments', soon: 'Phase 5' },
  { label: 'Automations', soon: 'Phase 6', permission: 'automation.manage' },
  { label: 'Knowledge', soon: 'Phase 8' },
  { label: 'Integrations', soon: 'Phase 5', permission: 'integrations.manage' },
  { label: 'Audit Log', soon: 'Phase 10', permission: 'audit.read' },
  { label: 'Settings', path: '/settings' },
];

export function Nav({ orgId, role }: { orgId: string; role: Role }) {
  const pathname = usePathname();
  const base = `/orgs/${orgId}`;
  const items = NAV.filter((item) => !item.permission || roleHasPermission(role, item.permission));

  return (
    <nav
      aria-label="Primary"
      className="flex gap-1 overflow-x-auto md:flex-col md:overflow-visible"
    >
      {items.map((item) => {
        if (item.path === undefined) {
          return (
            <span
              key={item.label}
              aria-disabled="true"
              title={`Coming in ${item.soon}`}
              className="flex cursor-not-allowed items-center justify-between gap-3 whitespace-nowrap rounded-lg px-3 py-2 text-sm text-muted/50"
            >
              {item.label}
              <span className="hidden rounded bg-white/5 px-1.5 py-0.5 font-mono text-[10px] md:inline">
                soon
              </span>
            </span>
          );
        }
        const href = `${base}${item.path}`;
        const active = item.path === '' ? pathname === base : pathname.startsWith(href);
        return (
          <Link
            key={item.label}
            href={href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'whitespace-nowrap rounded-lg px-3 py-2 text-sm transition',
              'focus-visible:outline-2 focus-visible:outline-accent',
              active
                ? 'bg-white/10 text-foreground'
                : 'text-muted hover:bg-white/5 hover:text-foreground',
            )}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
