import { Worker, type ConnectionOptions, type Job, type JobsOptions } from 'bullmq';
import type { Logger } from './logger';

/**
 * Retry policy applied by producers via `queue.add(name, data, DEFAULT_JOB_OPTIONS)`.
 * Handlers must be idempotent: a job can run more than once (retries, stalled-job recovery).
 */
export const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 1000 },
  removeOnComplete: { age: 3600, count: 1000 },
  removeOnFail: { age: 7 * 24 * 3600 },
};

export interface WorkerDefinition<Data, Result> {
  queue: string;
  concurrency: number;
  process(job: Job<Data>): Promise<Result>;
}

/** Create a BullMQ worker with consistent logging of job lifecycle events. */
export function createWorker<Data, Result>(
  definition: WorkerDefinition<Data, Result>,
  connection: ConnectionOptions,
  logger: Logger,
): Worker<Data, Result> {
  const worker = new Worker<Data, Result>(definition.queue, (job) => definition.process(job), {
    connection,
    concurrency: definition.concurrency,
  });

  const fields = (job: Job | undefined) => ({
    queue: definition.queue,
    jobId: job?.id,
    jobName: job?.name,
  });
  worker.on('completed', (job) => logger.debug('job completed', fields(job)));
  worker.on('failed', (job, error) =>
    logger.warn('job failed', {
      ...fields(job),
      attemptsMade: job?.attemptsMade,
      error: error.message,
    }),
  );
  worker.on('error', (error) =>
    logger.error('worker error', { queue: definition.queue, error: error.message }),
  );
  return worker;
}
