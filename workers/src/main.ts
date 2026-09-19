import { loadDotEnv, loadEnv, workerEnvSchema } from '@nexus/config';
import { createPrismaClient, pingDatabase } from '@nexus/database';
import { MAINTENANCE_JOBS, QUEUE_NAMES } from '@nexus/shared';
import { parseEncryptionKey } from '@nexus/shared/webhook-security';
import { Queue } from 'bullmq';
import { DEFAULT_JOB_OPTIONS, createWorker } from './create-worker';
import { startHealthServer } from './health-server';
import { createLogger } from './logger';
import { startDispatcher } from './monitoring/dispatcher';
import { createHttpChecker } from './monitoring/http-checker';
import { createActionHandlers } from './automation/actions/handlers';
import { startAutomationDispatcher } from './automation/dispatcher';
import { createLogEmailSender } from './automation/email';
import { createSafePoster } from './automation/safe-post';
import { createSmtpEmailSender, createSmtpTransporter } from './automation/smtp';
import {
  automationWorker,
  healthCheckWorker,
  maintenanceWorker,
  webhookWorker,
} from './processors/monitoring';
import { systemWorker } from './processors/system';
import { createBullConnection, createPublisherConnection } from './redis';

const HOUR_MS = 3_600_000;

async function main(): Promise<void> {
  loadDotEnv();
  const env = loadEnv(workerEnvSchema);
  const logger = createLogger(env.LOG_LEVEL, { service: 'nexus-worker' });

  const prisma = createPrismaClient(env.DATABASE_URL);
  const connection = createBullConnection(env.REDIS_URL);
  connection.on('error', (error) => logger.error('redis error', { error: error.message }));
  // Real-time signals to browsers (ADR-014); best-effort, so it has its own fail-fast connection.
  const realtime = createPublisherConnection(env.REDIS_URL);
  realtime.on('error', (error) => logger.warn('realtime redis error', { error: error.message }));

  // Email: `log` needs nothing; `smtp` needs a URL. Fail at startup, not at the first notification.
  if (env.EMAIL_TRANSPORT === 'smtp' && !env.SMTP_URL) {
    throw new Error('EMAIL_TRANSPORT=smtp requires SMTP_URL');
  }
  const email =
    env.EMAIL_TRANSPORT === 'smtp' && env.SMTP_URL
      ? createSmtpEmailSender({
          from: env.EMAIL_FROM,
          transporter: createSmtpTransporter(env.SMTP_URL),
        })
      : createLogEmailSender(logger);
  logger.info('email transport', { transport: env.EMAIL_TRANSPORT });

  const handlers = createActionHandlers({
    key: env.INTEGRATION_ENCRYPTION_KEY
      ? parseEncryptionKey(env.INTEGRATION_ENCRYPTION_KEY)
      : undefined,
    post: createSafePoster({ allowPrivate: env.MONITORING_ALLOW_PRIVATE_NETWORKS }),
  });

  const check = createHttpChecker({ allowPrivate: env.MONITORING_ALLOW_PRIVATE_NETWORKS });
  if (env.MONITORING_ALLOW_PRIVATE_NETWORKS) {
    logger.warn(
      'monitoring may target private/internal addresses (MONITORING_ALLOW_PRIVATE_NETWORKS=true)',
    );
  }

  // One worker per queue; add new queues here as later phases introduce them.
  const workers = [
    createWorker(systemWorker(env.WORKER_CONCURRENCY), connection, logger),
    createWorker(
      healthCheckWorker({ prisma, check, logger, realtime }, env.WORKER_CONCURRENCY),
      connection,
      logger,
    ),
    createWorker(
      maintenanceWorker({
        prisma,
        retentionDays: env.MONITORING_RESULT_RETENTION_DAYS,
        webhookRetentionDays: env.WEBHOOK_RETENTION_DAYS,
        automationRetentionDays: env.AUTOMATION_RETENTION_DAYS,
        notificationRetentionDays: env.NOTIFICATION_RETENTION_DAYS,
        logger,
      }),
      connection,
      logger,
    ),
    createWorker(
      webhookWorker({ prisma, logger, realtime }, env.WORKER_CONCURRENCY),
      connection,
      logger,
    ),
    createWorker(
      automationWorker(
        { prisma, logger, email, webOrigin: env.WEB_ORIGIN, handlers, realtime },
        env.WORKER_CONCURRENCY,
      ),
      connection,
      logger,
    ),
  ];

  const healthCheckQueue = new Queue(QUEUE_NAMES.healthCheck, { connection });
  const maintenanceQueue = new Queue(QUEUE_NAMES.maintenance, { connection });
  const automationQueue = new Queue(QUEUE_NAMES.automation, { connection });

  // Scheduler: claims due checks from the database and enqueues them (safe with several workers).
  const dispatcher = startDispatcher({
    prisma,
    queue: healthCheckQueue,
    logger,
    intervalMs: env.MONITORING_DISPATCH_INTERVAL_MS,
  });

  // Automation: turns domain events into rule executions (safe with several workers).
  const automationDispatcher = startAutomationDispatcher({
    prisma,
    queue: automationQueue,
    logger,
    intervalMs: env.AUTOMATION_DISPATCH_INTERVAL_MS,
    maxExecutionsPerRulePerHour: env.AUTOMATION_MAX_EXECUTIONS_PER_RULE_PER_HOUR,
    realtime,
  });

  // Hourly retention jobs. The job id is derived from the hour, so with several workers only one
  // job per hour is ever created.
  const scheduleCleanup = () => {
    const hour = Math.floor(Date.now() / HOUR_MS);
    for (const [name, prefix] of [
      [MAINTENANCE_JOBS.cleanupResults, 'cleanup'],
      [MAINTENANCE_JOBS.cleanupWebhooks, 'cleanup-webhooks'],
      [MAINTENANCE_JOBS.cleanupAutomation, 'cleanup-automation'],
    ] as const) {
      const slot = `${prefix}-${hour}`;
      maintenanceQueue
        .add(name, { slot }, { ...DEFAULT_JOB_OPTIONS, jobId: slot })
        .catch((error: unknown) =>
          logger.error('failed to schedule cleanup', {
            job: name,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
    }
  };
  scheduleCleanup();
  const cleanupTimer = setInterval(scheduleCleanup, HOUR_MS);

  const healthServer = startHealthServer(
    {
      host: env.WORKER_HEALTH_HOST,
      port: env.WORKER_HEALTH_PORT,
      probes: [
        { name: 'redis', check: () => connection.ping() },
        { name: 'postgres', check: () => pingDatabase(prisma) },
      ],
    },
    logger,
  );
  logger.info('workers started', { queues: workers.map((worker) => worker.name) });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('shutting down', { signal });
    healthServer.close();
    clearInterval(cleanupTimer);
    await dispatcher.stop();
    await automationDispatcher.stop();
    // close() waits for in-flight jobs to finish before resolving.
    await Promise.all(workers.map((worker) => worker.close()));
    await Promise.all([
      healthCheckQueue.close(),
      maintenanceQueue.close(),
      automationQueue.close(),
    ]);
    await Promise.allSettled([connection.quit(), realtime.quit()]);
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
