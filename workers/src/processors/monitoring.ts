import type { PrismaClient } from '@nexus/database';
import {
  HEALTH_CHECK_JOBS,
  MAINTENANCE_JOBS,
  QUEUE_NAMES,
  healthCheckPayloadSchema,
  maintenancePayloadSchema,
} from '@nexus/shared';
import type { Job } from 'bullmq';
import type { WorkerDefinition } from '../create-worker';
import type { Logger } from '../logger';
import { processHealthCheck, type HealthCheckOutcome } from '../monitoring/health-check';
import type { Checker } from '../monitoring/http-checker';
import { cleanupOldResults } from '../monitoring/maintenance';

export function healthCheckWorker(
  deps: { prisma: PrismaClient; check: Checker; logger: Logger },
  concurrency: number,
): WorkerDefinition<unknown, HealthCheckOutcome> {
  return {
    queue: QUEUE_NAMES.healthCheck,
    concurrency,
    async process(job: Job) {
      if (job.name !== HEALTH_CHECK_JOBS.run)
        throw new Error(`Unknown health-check job: ${job.name}`);
      // Every producer is an input boundary: validate even internal payloads.
      return processHealthCheck(deps, healthCheckPayloadSchema.parse(job.data));
    },
  };
}

export function maintenanceWorker(deps: {
  prisma: PrismaClient;
  retentionDays: number;
  logger: Logger;
}): WorkerDefinition<unknown, { deleted: number }> {
  return {
    queue: QUEUE_NAMES.maintenance,
    concurrency: 1,
    async process(job: Job) {
      if (job.name !== MAINTENANCE_JOBS.cleanupResults) {
        throw new Error(`Unknown maintenance job: ${job.name}`);
      }
      maintenancePayloadSchema.parse(job.data);
      const deleted = await cleanupOldResults(deps.prisma, deps.retentionDays);
      if (deleted > 0) deps.logger.info('deleted old monitoring results', { deleted });
      return { deleted };
    },
  };
}
