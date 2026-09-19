import { REALTIME_TOPICS } from '@nexus/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { liveStatus, pollEvery, queryKeysForTopic, SAFETY_NET_POLL_MS } from './realtime';

const ORG = 'org-1';

describe('queryKeysForTopic', () => {
  it('scopes every key to the organisation', () => {
    for (const topic of REALTIME_TOPICS) {
      for (const key of queryKeysForTopic(ORG, topic)) expect(key[1]).toBe(ORG);
    }
  });

  it('refreshes the dashboard when incidents change', () => {
    expect(queryKeysForTopic(ORG, 'incidents')).toContainEqual(['dashboard', ORG]);
  });

  it('refreshes only the notification queries for notifications', () => {
    expect(queryKeysForTopic(ORG, 'notifications').map((k) => k[0])).toEqual([
      'notifications',
      'notifications-unread',
    ]);
  });
});

describe('pollEvery', () => {
  afterEach(() => liveStatus.set(false));

  it('polls at the fallback rate while the stream is down', () => {
    expect(pollEvery(15_000)()).toBe(15_000);
  });

  it('only polls as a safety net while the stream is up', () => {
    liveStatus.set(true);
    expect(pollEvery(15_000)()).toBe(SAFETY_NET_POLL_MS);
  });
});
