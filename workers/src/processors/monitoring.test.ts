import type { PrismaClient } from '@nexus/database';
import type { Job } from 'bullmq';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  processHealthCheck: vi.fn(),
  processWebhookEvent: vi.fn(),
  markWebhookEventFailed: vi.fn(),
  processExecution: vi.fn(),
  cleanupOldResults: vi.fn(),
  cleanupOldWebhookEvents: vi.fn(),
  cleanupOldAutomationData: vi.fn(),
  cleanupOldNotifications: vi.fn(),
}));

vi.mock('../monitoring/health-check', () => ({ processHealthCheck: mocks.processHealthCheck }));
vi.mock('../github/process-webhook', () => ({
  processWebhookEvent: mocks.processWebhookEvent,
  markWebhookEventFailed: mocks.markWebhookEventFailed,
}));
vi.mock('../automation/executor', () => ({ processExecution: mocks.processExecution }));
vi.mock('../monitoring/maintenance', () => ({
  cleanupOldResults: mocks.cleanupOldResults,
  cleanupOldWebhookEvents: mocks.cleanupOldWebhookEvents,
}));
vi.mock('../automation/maintenance', () => ({
  cleanupOldAutomationData: mocks.cleanupOldAutomationData,
  cleanupOldNotifications: mocks.cleanupOldNotifications,
}));

import {
  automationWorker,
  healthCheckWorker,
  maintenanceWorker,
  webhookWorker,
} from './monitoring';

const ORG = '3f0c7c1e-0000-4000-8000-000000000001';
const ID = '3f0c7c1e-0000-4000-8000-000000000002';
const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const job = (name: string, data: unknown, extra: object = {}) =>
  ({ name, data, opts: {}, attemptsMade: 0, ...extra }) as unknown as Job;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('healthCheckWorker', () => {
  const data = { checkId: ID, organizationId: ORG, scheduledFor: '2026-01-01T00:00:00.000Z' };
  const prisma = {} as PrismaClient;

  it('rejects unknown jobs and malformed payloads before doing any work', async () => {
    const worker = healthCheckWorker({ prisma, check: vi.fn(), logger }, 3);
    expect(worker.concurrency).toBe(3);
    await expect(worker.process(job('other', data))).rejects.toThrow('Unknown health-check job');
    await expect(worker.process(job('run', { checkId: 'x' }))).rejects.toThrow();
    expect(mocks.processHealthCheck).not.toHaveBeenCalled();
  });

  it('announces a recorded result to the org, and only then', async () => {
    const publish = vi.fn().mockResolvedValue(1);
    const worker = healthCheckWorker({ prisma, check: vi.fn(), logger, realtime: { publish } }, 1);

    mocks.processHealthCheck.mockResolvedValueOnce({ kind: 'recorded' });
    await worker.process(job('run', data));
    expect(publish).toHaveBeenCalledTimes(2);

    publish.mockClear();
    mocks.processHealthCheck.mockResolvedValueOnce({ kind: 'skipped' });
    await worker.process(job('run', data));
    expect(publish).not.toHaveBeenCalled();
  });

  it('works without a realtime publisher', async () => {
    mocks.processHealthCheck.mockResolvedValueOnce({ kind: 'recorded' });
    const worker = healthCheckWorker({ prisma, check: vi.fn(), logger }, 1);
    await expect(worker.process(job('run', data))).resolves.toEqual({ kind: 'recorded' });
  });
});

describe('maintenanceWorker', () => {
  const prisma = {} as PrismaClient;
  const worker = maintenanceWorker({
    prisma,
    retentionDays: 30,
    webhookRetentionDays: 14,
    automationRetentionDays: 60,
    notificationRetentionDays: 90,
    logger,
  });

  it('cleans monitoring results with their own retention', async () => {
    mocks.cleanupOldResults.mockResolvedValue(5);
    expect(await worker.process(job('cleanup-results', { slot: 'a' }))).toEqual({ deleted: 5 });
    expect(mocks.cleanupOldResults).toHaveBeenCalledWith(prisma, 30);
    expect(logger.info).toHaveBeenCalled();
  });

  it('cleans webhook events, staying quiet when nothing was deleted', async () => {
    mocks.cleanupOldWebhookEvents.mockResolvedValue(0);
    expect(await worker.process(job('cleanup-webhooks', { slot: 'a' }))).toEqual({ deleted: 0 });
    expect(mocks.cleanupOldWebhookEvents).toHaveBeenCalledWith(prisma, 14);
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('sums automation data and notifications, each with its own retention', async () => {
    mocks.cleanupOldAutomationData.mockResolvedValue(2);
    mocks.cleanupOldNotifications.mockResolvedValue(3);
    expect(await worker.process(job('cleanup-automation', { slot: 'a' }))).toEqual({ deleted: 5 });
    expect(mocks.cleanupOldAutomationData).toHaveBeenCalledWith(prisma, 60);
    expect(mocks.cleanupOldNotifications).toHaveBeenCalledWith(prisma, 90);
  });

  it('rejects unknown jobs and bad payloads', async () => {
    await expect(worker.process(job('mystery', { slot: 'a' }))).rejects.toThrow(
      'Unknown maintenance job',
    );
    await expect(worker.process(job('cleanup-results', {}))).rejects.toThrow();
  });
});

describe('webhookWorker', () => {
  const prisma = {} as PrismaClient;
  const data = { webhookEventId: ID, organizationId: ORG, integrationId: ID };

  it('rejects unknown jobs', async () => {
    const worker = webhookWorker({ prisma, logger }, 1);
    await expect(worker.process(job('other', data))).rejects.toThrow('Unknown webhook job');
  });

  it('announces processed events and logs failed ones', async () => {
    const publish = vi.fn().mockResolvedValue(1);
    const worker = webhookWorker({ prisma, logger, realtime: { publish } }, 1);

    mocks.processWebhookEvent.mockResolvedValueOnce({ status: 'processed' });
    await worker.process(job('process', data));
    expect(publish).toHaveBeenCalledTimes(1);

    publish.mockClear();
    mocks.processWebhookEvent.mockResolvedValueOnce({ status: 'failed', reason: 'bad payload' });
    await worker.process(job('process', data));
    expect(publish).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      'webhook event could not be processed',
      expect.objectContaining({ reason: 'bad payload' }),
    );
  });

  it('retries transient errors without marking the event failed until attempts run out', async () => {
    const worker = webhookWorker({ prisma, logger }, 1);
    mocks.processWebhookEvent.mockRejectedValue(new Error('db down'));
    mocks.markWebhookEventFailed.mockResolvedValue(undefined);

    await expect(
      worker.process(job('process', data, { opts: { attempts: 3 }, attemptsMade: 0 })),
    ).rejects.toThrow('db down');
    expect(mocks.markWebhookEventFailed).not.toHaveBeenCalled();

    await expect(
      worker.process(job('process', data, { opts: { attempts: 3 }, attemptsMade: 2 })),
    ).rejects.toThrow('db down');
    expect(mocks.markWebhookEventFailed).toHaveBeenCalledWith(prisma, expect.anything(), 'db down');
  });

  it('still surfaces the original error if recording the failure also fails', async () => {
    const worker = webhookWorker({ prisma, logger }, 1);
    mocks.processWebhookEvent.mockRejectedValue(new Error('original'));
    mocks.markWebhookEventFailed.mockRejectedValue(new Error('second'));
    await expect(worker.process(job('process', data))).rejects.toThrow('original');
  });
});

describe('automationWorker', () => {
  const data = { executionId: ID, organizationId: ORG };

  it('rejects unknown jobs', async () => {
    const worker = automationWorker({} as never, 1);
    await expect(worker.process(job('other', data))).rejects.toThrow('Unknown automation job');
  });

  it('tells the executor when this is the final attempt', async () => {
    mocks.processExecution.mockResolvedValue({ status: 'retry' });
    const worker = automationWorker({} as never, 1);
    await worker.process(job('execute', data, { opts: { attempts: 3 }, attemptsMade: 1 }));
    expect(mocks.processExecution).toHaveBeenLastCalledWith(expect.anything(), data, {
      isFinalAttempt: false,
    });
    await worker.process(job('execute', data, { opts: { attempts: 3 }, attemptsMade: 2 }));
    expect(mocks.processExecution).toHaveBeenLastCalledWith(expect.anything(), data, {
      isFinalAttempt: true,
    });
  });

  it('announces a finished run to each notified user once, plus the shared topics', async () => {
    mocks.processExecution.mockResolvedValue({ status: 'finished' });
    const publish = vi.fn().mockResolvedValue(1);
    const findMany = vi
      .fn()
      .mockResolvedValue([{ userId: 'u1' }, { userId: 'u1' }, { userId: 'u2' }]);
    const prisma = { notification: { findMany } } as unknown as PrismaClient;
    const worker = automationWorker({ prisma, realtime: { publish } } as never, 1);

    await worker.process(job('execute', data));
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { executionId: ID, organizationId: ORG } }),
    );
    // automation + incidents + one notifications message per distinct user
    expect(publish).toHaveBeenCalledTimes(4);
  });

  it('still announces when the notification lookup fails', async () => {
    mocks.processExecution.mockResolvedValue({ status: 'finished' });
    const publish = vi.fn().mockResolvedValue(1);
    const prisma = {
      notification: { findMany: vi.fn().mockRejectedValue(new Error('x')) },
    } as unknown as PrismaClient;
    const worker = automationWorker({ prisma, realtime: { publish } } as never, 1);
    await worker.process(job('execute', data));
    expect(publish).toHaveBeenCalledTimes(2);
  });

  it('does not announce runs that did not finish', async () => {
    mocks.processExecution.mockResolvedValue({ status: 'skipped' });
    const publish = vi.fn();
    const worker = automationWorker({ realtime: { publish } } as never, 1);
    await worker.process(job('execute', data));
    expect(publish).not.toHaveBeenCalled();
  });
});
