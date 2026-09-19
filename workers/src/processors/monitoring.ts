import type { PrismaClient } from '@nexus/database';
import {
  HEALTH_CHECK_JOBS,
  AUTOMATION_JOBS,
  MAINTENANCE_JOBS,
  QUEUE_NAMES,
  WEBHOOK_JOBS,
  automationJobPayloadSchema,
  healthCheckPayloadSchema,
  maintenancePayloadSchema,
  webhookProcessingPayloadSchema,
} from '@nexus/shared';
import type { Job } from 'bullmq';
import type { WorkerDefinition } from '../create-worker';
import type { Logger } from '../logger';
import { processHealthCheck, type HealthCheckOutcome } from '../monitoring/health-check';
import type { Checker } from '../monitoring/http-checker';
import {
  markWebhookEventFailed,
  processWebhookEvent,
  type WebhookProcessingOutcome,
} from '../github/process-webhook';
import { cleanupOldAutomationData, cleanupOldNotifications } from '../automation/maintenance';
import { processExecution, type ExecutionOutcome, type ExecutorDeps } from '../automation/executor';
import { cleanupOldResults, cleanupOldWebhookEvents } from '../monitoring/maintenance';

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
  webhookRetentionDays: number;
  automationRetentionDays: number;
  notificationRetentionDays: number;
  logger: Logger;
}): WorkerDefinition<unknown, { deleted: number }> {
  return {
    queue: QUEUE_NAMES.maintenance,
    concurrency: 1,
    async process(job: Job) {
      maintenancePayloadSchema.parse(job.data);
      if (job.name === MAINTENANCE_JOBS.cleanupResults) {
        const deleted = await cleanupOldResults(deps.prisma, deps.retentionDays);
        if (deleted > 0) deps.logger.info('deleted old monitoring results', { deleted });
        return { deleted };
      }
      if (job.name === MAINTENANCE_JOBS.cleanupWebhooks) {
        const deleted = await cleanupOldWebhookEvents(deps.prisma, deps.webhookRetentionDays);
        if (deleted > 0) deps.logger.info('deleted old webhook events', { deleted });
        return { deleted };
      }
      if (job.name === MAINTENANCE_JOBS.cleanupAutomation) {
        const events = await cleanupOldAutomationData(deps.prisma, deps.automationRetentionDays);
        const notifications = await cleanupOldNotifications(
          deps.prisma,
          deps.notificationRetentionDays,
        );
        if (events + notifications > 0) {
          deps.logger.info('deleted old automation data', { events, notifications });
        }
        return { deleted: events + notifications };
      }
      throw new Error(`Unknown maintenance job: ${job.name}`);
    },
  };
}

export function webhookWorker(
  deps: { prisma: PrismaClient; logger: Logger },
  concurrency: number,
): WorkerDefinition<unknown, WebhookProcessingOutcome> {
  return {
    queue: QUEUE_NAMES.webhookProcessing,
    concurrency,
    async process(job: Job) {
      if (job.name !== WEBHOOK_JOBS.process) throw new Error(`Unknown webhook job: ${job.name}`);
      const payload = webhookProcessingPayloadSchema.parse(job.data);
      try {
        const outcome = await processWebhookEvent(deps, payload);
        if (outcome.status === 'failed') {
          deps.logger.warn('webhook event could not be processed', {
            webhookEventId: payload.webhookEventId,
            reason: outcome.reason,
          });
        }
        return outcome;
      } catch (error) {
        // Transient errors are retried; once retries are exhausted, record the failure on the event.
        const attempts = job.opts.attempts ?? 1;
        if (job.attemptsMade + 1 >= attempts) {
          await markWebhookEventFailed(
            deps.prisma,
            payload,
            error instanceof Error ? error.message : 'processing failed',
          ).catch(() => undefined);
        }
        throw error;
      }
    },
  };
}

export function automationWorker(
  deps: ExecutorDeps,
  concurrency: number,
): WorkerDefinition<unknown, ExecutionOutcome> {
  return {
    queue: QUEUE_NAMES.automation,
    concurrency,
    async process(job: Job) {
      if (job.name !== AUTOMATION_JOBS.execute) {
        throw new Error(`Unknown automation job: ${job.name}`);
      }
      const payload = automationJobPayloadSchema.parse(job.data);
      const isFinalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
      return processExecution(deps, payload, { isFinalAttempt });
    },
  };
}
