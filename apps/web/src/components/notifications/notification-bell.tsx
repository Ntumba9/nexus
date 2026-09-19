'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { Popover } from '@/components/shell/popover';
import { Alert, Skeleton } from '@/components/ui/feedback';
import { apiFetch, describeError } from '@/lib/api-client';
import { timeAgo } from '@/lib/incident-format';
import { fetchers, keys } from '@/lib/queries';
import { cn } from '@/lib/utils';

/** The notifications bell: an unread badge, and the latest few in a popover. */
export function NotificationBell({ orgId }: { orgId: string }) {
  const unread = useQuery({
    queryKey: keys.unread(orgId),
    queryFn: () => fetchers.unread(orgId),
    refetchInterval: 20_000, // live push arrives with real-time updates in a later phase
  });
  const count = unread.data ?? 0;

  return (
    <Popover
      align="right"
      triggerLabel={count > 0 ? `Notifications, ${count} unread` : 'Notifications'}
      trigger={
        <span className="relative flex items-center">
          <svg
            aria-hidden
            viewBox="0 0 24 24"
            className="size-5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
            <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
          </svg>
          {count > 0 && (
            <span
              aria-hidden
              className="absolute -right-2 -top-2 grid min-w-4 place-items-center rounded-full bg-accent px-1 text-[10px] font-semibold leading-4 text-background"
            >
              {count > 99 ? '99+' : count}
            </span>
          )}
        </span>
      }
    >
      {(close) => <BellPanel orgId={orgId} close={close} />}
    </Popover>
  );
}

function BellPanel({ orgId, close }: { orgId: string; close: () => void }) {
  const queryClient = useQueryClient();
  const list = useQuery({
    queryKey: [...keys.notifications(orgId), 'bell'],
    queryFn: () => fetchers.notifications(orgId, { limit: 8 }),
  });

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: keys.notifications(orgId) }),
      queryClient.invalidateQueries({ queryKey: keys.unread(orgId) }),
    ]);
  const markRead = useMutation({
    mutationFn: (id: string) =>
      apiFetch(`/orgs/${orgId}/notifications/${id}/read`, { method: 'POST' }),
    onSuccess: refresh,
  });
  const markAll = useMutation({
    mutationFn: () => apiFetch(`/orgs/${orgId}/notifications/read-all`, { method: 'POST' }),
    onSuccess: refresh,
  });

  return (
    <div className="w-80 max-w-[calc(100vw-2rem)]">
      <div className="flex items-center justify-between px-3 py-2">
        <p className="text-sm font-medium">Notifications</p>
        <button
          type="button"
          disabled={markAll.isPending || (list.data?.unreadCount ?? 0) === 0}
          onClick={() => markAll.mutate()}
          className="text-xs text-accent hover:underline disabled:cursor-not-allowed disabled:text-muted disabled:no-underline"
        >
          Mark all read
        </button>
      </div>
      {list.isPending && (
        <div aria-busy="true" aria-label="Loading notifications" className="space-y-2 px-3 pb-3">
          <Skeleton className="h-10" />
          <Skeleton className="h-10" />
        </div>
      )}
      {list.isError && (
        <div className="px-3 pb-3">
          <Alert>{describeError(list.error)}</Alert>
        </div>
      )}
      {list.data && list.data.data.length === 0 && (
        <p className="px-3 pb-4 text-sm text-muted">You are all caught up.</p>
      )}
      {list.data && list.data.data.length > 0 && (
        <ul className="max-h-96 overflow-y-auto">
          {list.data.data.map((notification) => {
            const unreadItem = notification.readAt === null;
            const body = (
              <>
                <span className="flex items-start gap-2">
                  <span
                    aria-hidden
                    className={cn(
                      'mt-1.5 size-2 shrink-0 rounded-full',
                      unreadItem ? 'bg-accent' : 'bg-transparent',
                    )}
                  />
                  <span className="min-w-0">
                    {/* Rendered as text: React escapes it, so notification content cannot inject markup. */}
                    <span className={cn('block text-sm', unreadItem && 'font-medium')}>
                      {notification.title}
                    </span>
                    <span className="block text-xs text-muted">
                      {timeAgo(notification.createdAt)}
                    </span>
                  </span>
                </span>
              </>
            );
            return (
              <li key={notification.id}>
                {notification.link ? (
                  <Link
                    href={notification.link}
                    onClick={() => {
                      if (unreadItem) markRead.mutate(notification.id);
                      close();
                    }}
                    className="block rounded-lg px-3 py-2 hover:bg-white/5"
                  >
                    {body}
                  </Link>
                ) : (
                  <button
                    type="button"
                    onClick={() => unreadItem && markRead.mutate(notification.id)}
                    className="block w-full rounded-lg px-3 py-2 text-left hover:bg-white/5"
                  >
                    {body}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <div className="border-t border-border p-2">
        <Link
          href={`/orgs/${orgId}/notifications`}
          onClick={close}
          className="block rounded-lg px-3 py-2 text-center text-sm text-accent hover:bg-white/5"
        >
          View all
        </Link>
      </div>
    </div>
  );
}
