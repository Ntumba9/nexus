import { Queue, QueueEvents } from 'bullmq';
import { QUEUE_NAMES, SYSTEM_JOBS, systemPingResultSchema } from '@nexus/shared';
import { afterAll, describe, expect, it } from 'vitest';
import { createWorker, DEFAULT_JOB_OPTIONS } from './create-worker';
import { createLogger } from './logger';
import { systemWorker } from './processors/system';
import { createBullConnection } from './redis';

// Requires a running Redis (`pnpm dev:infra`). Skipped when REDIS_URL is not set.
const redisUrl = process.env.REDIS_URL;

describe.skipIf(!redisUrl)('BullMQ pipeline (integration)', () => {
  const url = redisUrl ?? 'redis://unused';
  const connection = createBullConnection(url);
  const queue = new Queue(QUEUE_NAMES.system, { connection });
  const events = new QueueEvents(QUEUE_NAMES.system, { connection: createBullConnection(url) });
  const worker = createWorker(systemWorker(1), connection, createLogger('silent'));

  afterAll(async () => {
    await worker.close();
    await events.close();
    await queue.close();
    connection.disconnect();
  });

  it('runs a ping job end to end', async () => {
    await events.waitUntilReady();
    const nonce = `it-${Date.now()}`;
    const job = await queue.add(SYSTEM_JOBS.ping, { nonce }, DEFAULT_JOB_OPTIONS);
    const result = systemPingResultSchema.parse(await job.waitUntilFinished(events, 10_000));
    expect(result.nonce).toBe(nonce);
  });
});
