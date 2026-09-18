import type { Job } from 'bullmq';
import {
  QUEUE_NAMES,
  SYSTEM_JOBS,
  systemPingPayloadSchema,
  type SystemPingResult,
} from '@nexus/shared';
import type { WorkerDefinition } from '../create-worker';

/**
 * Infrastructure smoke job: proves a job travels API/CLI → Redis → BullMQ → worker → result.
 * Payloads are validated even for internal jobs, because every producer is an input boundary.
 */
export async function processSystemJob(job: Job): Promise<SystemPingResult> {
  if (job.name !== SYSTEM_JOBS.ping) {
    throw new Error(`Unknown system job: ${job.name}`);
  }
  const payload = systemPingPayloadSchema.parse(job.data);
  return { nonce: payload.nonce, processedAt: new Date().toISOString() };
}

export function systemWorker(concurrency: number): WorkerDefinition<unknown, SystemPingResult> {
  return { queue: QUEUE_NAMES.system, concurrency, process: processSystemJob };
}
