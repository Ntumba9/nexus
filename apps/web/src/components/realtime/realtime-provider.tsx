'use client';

import { useQueryClient } from '@tanstack/react-query';
import { realtimeTopicSchema, type RealtimeTopic } from '@nexus/shared';
import { useEffect, useSyncExternalStore } from 'react';
import { liveStatus, queryKeysForTopic } from '@/lib/realtime';

/** Signals arriving close together (one change often touches several topics) are handled together. */
const BATCH_MS = 150;

/**
 * Opens the organisation's Server-Sent Events stream and turns each signal into cache invalidation.
 * Renders nothing. If the stream cannot open (old browser, proxy, signed out) the app keeps working
 * on its normal polling; the stream only makes it faster.
 */
export function RealtimeProvider({ orgId }: { orgId: string }) {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (typeof EventSource === 'undefined') return;

    const pending = new Set<RealtimeTopic>();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let everConnected = false;

    const flush = () => {
      timer = undefined;
      for (const topic of pending) {
        for (const queryKey of queryKeysForTopic(orgId, topic)) {
          void queryClient.invalidateQueries({ queryKey });
        }
      }
      pending.clear();
    };

    const source = new EventSource(`/api/v1/orgs/${orgId}/events`, { withCredentials: true });

    source.addEventListener('ready', () => {
      liveStatus.set(true);
      // After a reconnect we may have missed signals: refetch everything for this organisation.
      if (everConnected) {
        void queryClient.invalidateQueries({
          predicate: (query) => query.queryKey[1] === orgId,
        });
      }
      everConnected = true;
    });

    source.addEventListener('change', (event) => {
      let topic: unknown;
      try {
        topic = (JSON.parse((event as MessageEvent<string>).data) as { topic?: unknown }).topic;
      } catch {
        return;
      }
      const parsed = realtimeTopicSchema.safeParse(topic);
      if (!parsed.success) return;
      pending.add(parsed.data);
      timer ??= setTimeout(flush, BATCH_MS);
    });

    // EventSource reconnects by itself; until it does, fall back to polling.
    source.addEventListener('error', () => liveStatus.set(false));

    return () => {
      source.close();
      if (timer) clearTimeout(timer);
      liveStatus.set(false);
    };
  }, [orgId, queryClient]);

  return null;
}

/** A small "Live" indicator for the header. */
export function LiveIndicator() {
  const live = useSyncExternalStore(liveStatus.subscribe, liveStatus.get, () => false);
  return (
    <span
      role="status"
      title={
        live ? 'Updates arrive live' : 'Live updates are not connected; refreshing periodically'
      }
      className="flex items-center gap-1.5 text-xs text-muted"
    >
      <span
        aria-hidden
        className={`size-2 rounded-full ${live ? 'bg-emerald-400' : 'bg-zinc-600'}`}
      />
      <span className="hidden sm:inline">{live ? 'Live' : 'Polling'}</span>
    </span>
  );
}
