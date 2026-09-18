import { Redis } from 'ioredis';

/**
 * BullMQ workers use blocking commands, which requires `maxRetriesPerRequest: null`.
 * Each Queue/Worker/QueueEvents should get its own connection (BullMQ duplicates as needed).
 */
export function createBullConnection(url: string): Redis {
  return new Redis(url, { maxRetriesPerRequest: null });
}
