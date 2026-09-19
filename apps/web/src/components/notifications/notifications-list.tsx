'use client';

import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Alert, EmptyState, Skeleton } from '@/components/ui/feedback';
import { apiFetch, describeError } from '@/lib/api-client';
import { formatDateTime, timeAgo } from '@/lib/incident-format';
import { fetchers, keys } from '@/lib/queries';
import { cn } from '@/lib/utils';

/** The full inbox: everything sent to the signed-in user in this organization. */
export function NotificationsList({ orgId }: { orgId: string }) {
  const queryClient = useQueryClient();
  const query = useInfiniteQuery({
    queryKey: [...keys.notifications(orgId), 'page'],
    queryFn: ({ pageParam }) => fetchers.notifications(orgId, { before: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextBefore ?? undefined,
    refetchInterval: 30_000,
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

  if (query.isPending) {
    return (
      <div aria-busy="true" aria-label="Loading notifications" className="space-y-2">
        <Skeleton className="h-16" />
        <Skeleton className="h-16" />
      </div>
    );
  }
  if (query.isError) {
    return (
      <div className="space-y-3">
        <Alert>{describeError(query.error)}</Alert>
        <Button variant="secondary" size="sm" onClick={() => query.refetch()}>
          Retry
        </Button>
      </div>
    );
  }

  const items = query.data.pages.flatMap((page) => page.data);
  const unreadCount = query.data.pages[0]?.unreadCount ?? 0;
  if (items.length === 0) {
    return (
      <EmptyState
        title="No notifications yet"
        description="When an automation rule notifies you, it appears here."
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted">{unreadCount} unread</p>
        <Button
          size="sm"
          variant="secondary"
          disabled={unreadCount === 0}
          loading={markAll.isPending}
          onClick={() => markAll.mutate()}
        >
          Mark all read
        </Button>
      </div>
      <ul
        aria-label="Notifications"
        className="divide-y divide-border rounded-xl border border-border"
      >
        {items.map((notification) => {
          const unread = notification.readAt === null;
          return (
            <li key={notification.id} className="flex items-start justify-between gap-4 px-4 py-3">
              <div className="min-w-0 space-y-1">
                <p className={cn('text-sm', unread && 'font-medium')}>
                  {notification.link ? (
                    <Link
                      href={notification.link}
                      onClick={() => unread && markRead.mutate(notification.id)}
                      className="hover:underline"
                    >
                      {notification.title}
                    </Link>
                  ) : (
                    notification.title
                  )}
                </p>
                {notification.body && (
                  <p className="whitespace-pre-wrap text-xs text-muted">{notification.body}</p>
                )}
                <p className="text-xs text-muted" title={formatDateTime(notification.createdAt)}>
                  {timeAgo(notification.createdAt)}
                </p>
              </div>
              {unread ? (
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Mark “${notification.title}” as read`}
                  onClick={() => markRead.mutate(notification.id)}
                >
                  Mark read
                </Button>
              ) : (
                <span className="text-xs text-muted">Read</span>
              )}
            </li>
          );
        })}
      </ul>
      {query.hasNextPage && (
        <Button
          variant="secondary"
          loading={query.isFetchingNextPage}
          onClick={() => query.fetchNextPage()}
        >
          Show older
        </Button>
      )}
    </div>
  );
}
