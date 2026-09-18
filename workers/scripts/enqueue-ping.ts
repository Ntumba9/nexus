/**
 * Smoke test for the queue pipeline. With Redis and the worker running, enqueues a `system:ping`
 * job and waits for the worker's result:  pnpm --filter @nexus/workers smoke
 */
import { loadDotEnv, loadEnv, workerEnvSchema } from '@nexus/config';
import { QUEUE_NAMES, SYSTEM_JOBS, systemPingResultSchema } from '@nexus/shared';
import { Queue, QueueEvents } from 'bullmq';
import { DEFAULT_JOB_OPTIONS } from '../src/create-worker';
import { createBullConnection } from '../src/redis';

async function run(): Promise<void> {
  loadDotEnv();
  const env = loadEnv(workerEnvSchema);
  const queue = new Queue(QUEUE_NAMES.system, { connection: createBullConnection(env.REDIS_URL) });
  const events = new QueueEvents(QUEUE_NAMES.system, {
    connection: createBullConnection(env.REDIS_URL),
  });
  try {
    await events.waitUntilReady();
    const nonce = `smoke-${Date.now()}`;
    const job = await queue.add(SYSTEM_JOBS.ping, { nonce }, DEFAULT_JOB_OPTIONS);
    const result = systemPingResultSchema.parse(await job.waitUntilFinished(events, 10_000));
    console.log(
      `OK: worker processed job ${job.id} (nonce ${result.nonce}) at ${result.processedAt}`,
    );
  } finally {
    await events.close();
    await queue.close();
  }
}

run().catch((error: unknown) => {
  console.error(`Smoke test failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
