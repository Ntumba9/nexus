import type { RealtimeTopic } from '@nexus/shared';
import { keys } from './queries';

/**
 * Which cached queries a topic makes stale. Messages carry no data (ADR-014), so the browser simply
 * refetches these through the REST API, where authorization already lives.
 */
export function queryKeysForTopic(orgId: string, topic: RealtimeTopic): (readonly unknown[])[] {
  switch (topic) {
    case 'incidents':
      return [
        ['incidents', orgId],
        ['incident', orgId],
        ['incident-events', orgId],
        keys.dashboard(orgId),
      ];
    case 'projects':
      return [['projects', orgId], ['project', orgId], ['services', orgId], keys.dashboard(orgId)];
    case 'services':
      return [['services', orgId], keys.dashboard(orgId)];
    case 'monitoring':
      return [['checks', orgId], ['check-results', orgId], keys.dashboard(orgId)];
    case 'deployments':
      return [
        ['deployments', orgId],
        ['incident-deployments', orgId],
      ];
    case 'integrations':
      return [keys.integrations(orgId)];
    case 'automation':
      return [
        keys.rules(orgId),
        ['automation-executions', orgId],
        keys.webhooks(orgId),
        ['audit-log', orgId],
      ];
    case 'notifications':
      return [keys.notifications(orgId), keys.unread(orgId)];
    case 'members':
      return [keys.members(orgId)];
    case 'organization':
      return [];
  }
}

/** With a live stream, polling is only a safety net for a signal that was lost. */
export const SAFETY_NET_POLL_MS = 60_000;

type Listener = () => void;

/** Whether the real-time stream is connected. A module-level store so polling can read it anywhere. */
class LiveStatus {
  private live = false;
  private readonly listeners = new Set<Listener>();

  get = (): boolean => this.live;

  set(value: boolean): void {
    if (this.live === value) return;
    this.live = value;
    for (const listener of this.listeners) listener();
  }

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
}

export const liveStatus = new LiveStatus();

/**
 * A `refetchInterval` that polls at `fallbackMs` while the stream is down and only occasionally
 * while it is up.
 */
export const pollEvery = (fallbackMs: number) => (): number =>
  liveStatus.get() ? Math.max(fallbackMs, SAFETY_NET_POLL_MS) : fallbackMs;
