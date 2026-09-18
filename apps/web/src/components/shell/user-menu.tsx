'use client';

import type { UserDto } from '@nexus/shared';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { apiFetch, describeError } from '@/lib/api-client';
import { Popover } from './popover';

function initials(name: string): string {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]!.toUpperCase())
      .join('') || '?'
  );
}

export function UserMenu({ user }: { user: UserDto }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function logout() {
    setPending(true);
    setError(null);
    try {
      await apiFetch('/auth/logout', { method: 'POST' });
      router.replace('/login');
      router.refresh();
    } catch (err) {
      setError(describeError(err));
      setPending(false);
    }
  }

  return (
    <Popover
      align="right"
      triggerLabel="Account menu"
      trigger={
        <span
          aria-hidden
          className="grid size-6 place-items-center rounded-full bg-accent/20 text-[11px] font-semibold text-accent"
        >
          {initials(user.name)}
        </span>
      }
    >
      <div className="px-3 py-2">
        <p className="truncate text-sm font-medium">{user.name}</p>
        <p className="truncate text-xs text-muted">{user.email}</p>
      </div>
      <div className="border-t border-border p-1">
        {error && (
          <p role="alert" className="px-2 pb-2 text-xs text-danger">
            {error}
          </p>
        )}
        <Button
          variant="ghost"
          size="sm"
          className="w-full justify-start"
          loading={pending}
          onClick={logout}
        >
          Log out
        </Button>
      </div>
    </Popover>
  );
}
