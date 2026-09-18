'use client';

import type { MembershipDto } from '@nexus/shared';
import Link from 'next/link';
import { rememberOrganization } from '@/lib/last-org';
import { cn } from '@/lib/utils';
import { Popover } from './popover';

export function OrgSwitcher({
  memberships,
  currentId,
}: {
  memberships: MembershipDto[];
  currentId: string;
}) {
  const current = memberships.find((m) => m.organizationId === currentId);

  return (
    <Popover
      triggerLabel="Switch organization"
      trigger={
        <>
          <span className="max-w-40 truncate font-medium">{current?.name ?? 'Organization'}</span>
          <span aria-hidden className="text-muted">
            ▾
          </span>
        </>
      }
    >
      {(close) => (
        <>
          <p className="px-3 py-2 text-xs uppercase tracking-wider text-muted">Organizations</p>
          <ul>
            {memberships.map((m) => (
              <li key={m.organizationId}>
                <Link
                  href={`/orgs/${m.organizationId}`}
                  onClick={() => {
                    rememberOrganization(m.organizationId);
                    close();
                  }}
                  aria-current={m.organizationId === currentId ? 'true' : undefined}
                  className={cn(
                    'flex items-center justify-between gap-4 rounded-lg px-3 py-2 text-sm hover:bg-white/5',
                    m.organizationId === currentId && 'bg-white/5',
                  )}
                >
                  <span className="truncate">{m.name}</span>
                  <span className="font-mono text-[10px] text-muted">{m.role}</span>
                </Link>
              </li>
            ))}
          </ul>
          <div className="mt-1 border-t border-border pt-1">
            <Link
              href="/onboarding"
              onClick={close}
              className="block rounded-lg px-3 py-2 text-sm text-accent hover:bg-white/5"
            >
              + Create organization
            </Link>
          </div>
        </>
      )}
    </Popover>
  );
}
