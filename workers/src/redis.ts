import { Redis } from 'ioredis';

/**
 * BullMQ workers use blocking commands, which requires `maxRetriesPerRequest: null`.
 * Each Queue/Worker/QueueEvents should get its own connection (BullMQ duplicates as needed).
 */
export function createBullConnection(url: string): Redis {
  return new Redis(url, { maxRetriesPerRequest: null });
}

/**
 * A connection for real-time signals. Unlike the BullMQ connection it fails fast when Redis is
 * unreachable instead of queueing commands forever: a signal is best-effort and must never hold up
 * the job that produced it.
 */
export function createPublisherConnection(url: string): Redis {
  return new Redis(url, { maxRetriesPerRequest: 1, enableOfflineQueue: false });
}
