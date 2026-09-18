import { Global, Inject, Logger, Module, type OnApplicationShutdown } from '@nestjs/common';
import { apiEnvSchema, loadEnv, type ApiEnv } from '@nexus/config';
import { createPrismaClient, type PrismaClient } from '@nexus/database';
import { Redis } from 'ioredis';
import { ENV, PRISMA, REDIS } from './tokens';

const logger = new Logger('Infrastructure');
const REDIS_STARTUP_TIMEOUT_MS = 5000;

function waitUntilReady(redis: Redis, timeoutMs: number): Promise<void> {
  if (redis.status === 'ready') return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      redis.off('ready', onReady);
      reject(new Error(`Redis not ready after ${timeoutMs}ms`));
    }, timeoutMs);
    const onReady = () => {
      clearTimeout(timer);
      resolve();
    };
    redis.once('ready', onReady);
  });
}

/**
 * Owns the process-wide connections (config, PostgreSQL, Redis) and closes them on shutdown.
 * Explicit `@Inject` tokens are used throughout the API so classes also work under test runners
 * that do not emit decorator metadata.
 */
@Global()
@Module({
  providers: [
    { provide: ENV, useFactory: (): ApiEnv => loadEnv(apiEnvSchema) },
    {
      provide: PRISMA,
      inject: [ENV],
      useFactory: (env: ApiEnv): PrismaClient => createPrismaClient(env.DATABASE_URL),
    },
    {
      provide: REDIS,
      inject: [ENV],
      useFactory: async (env: ApiEnv): Promise<Redis> => {
        // Fail fast instead of queueing commands while disconnected: readiness must reflect reality.
        const redis = new Redis(env.REDIS_URL, {
          maxRetriesPerRequest: 1,
          enableOfflineQueue: false,
        });
        redis.on('error', (error: Error) => logger.warn(`Redis error: ${error.message}`));
        // With the offline queue disabled, commands sent before the connection is ready are
        // rejected. Wait for it at startup so the first requests after a boot are not refused.
        // If Redis is genuinely down we still start, and readiness/limits report it honestly.
        await waitUntilReady(redis, REDIS_STARTUP_TIMEOUT_MS).catch(() =>
          logger.warn('Redis was not ready at startup; continuing and retrying in the background'),
        );
        return redis;
      },
    },
  ],
  exports: [ENV, PRISMA, REDIS],
})
export class InfrastructureModule implements OnApplicationShutdown {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    await Promise.allSettled([this.prisma.$disconnect(), this.redis.quit()]);
  }
}
