import { loadDotEnv, loadEnv, workerEnvSchema } from '@nexus/config';
import { createWorker } from './create-worker';
import { startHealthServer } from './health-server';
import { createLogger } from './logger';
import { systemWorker } from './processors/system';
import { createBullConnection } from './redis';

async function main(): Promise<void> {
  loadDotEnv();
  const env = loadEnv(workerEnvSchema);
  const logger = createLogger(env.LOG_LEVEL, { service: 'nexus-worker' });

  const connection = createBullConnection(env.REDIS_URL);
  connection.on('error', (error) => logger.error('redis error', { error: error.message }));

  // Register one worker per queue here as later phases add queues.
  const workers = [createWorker(systemWorker(env.WORKER_CONCURRENCY), connection, logger)];
  const healthServer = startHealthServer(
    { host: env.WORKER_HEALTH_HOST, port: env.WORKER_HEALTH_PORT, redis: connection },
    logger,
  );
  logger.info('workers started', { queues: workers.map((worker) => worker.name) });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('shutting down', { signal });
    healthServer.close();
    // close() waits for in-flight jobs to finish before resolving.
    await Promise.all(workers.map((worker) => worker.close()));
    await connection.quit();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
