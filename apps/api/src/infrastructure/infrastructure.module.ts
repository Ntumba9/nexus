import { Global, Inject, Logger, Module, type OnApplicationShutdown } from '@nestjs/common';
import { apiEnvSchema, loadEnv, type ApiEnv } from '@nexus/config';
import { createPrismaClient, type PrismaClient } from '@nexus/database';
import { Redis } from 'ioredis';
import { ENV, PRISMA, REDIS } from './tokens';

const logger = new Logger('Infrastructure');

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
      useFactory: (env: ApiEnv): Redis => {
        // Fail fast instead of queueing commands while disconnected: readiness must reflect reality.
        const redis = new Redis(env.REDIS_URL, {
          maxRetriesPerRequest: 1,
          enableOfflineQueue: false,
        });
        redis.on('error', (error: Error) => logger.warn(`Redis error: ${error.message}`));
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
