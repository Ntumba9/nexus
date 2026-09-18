import { Module } from '@nestjs/common';
import { pingDatabase, type PrismaClient } from '@nexus/database';
import type { Redis } from 'ioredis';
import { PRISMA, REDIS } from '../infrastructure/tokens';
import { HealthController } from './health.controller';
import { HEALTH_PROBES, HealthService, type HealthProbe } from './health.service';

@Module({
  controllers: [HealthController],
  providers: [
    {
      provide: HEALTH_PROBES,
      inject: [PRISMA, REDIS],
      useFactory: (prisma: PrismaClient, redis: Redis): HealthProbe[] => [
        { name: 'postgres', check: () => pingDatabase(prisma) },
        {
          name: 'redis',
          check: async () => {
            if ((await redis.ping()) !== 'PONG') throw new Error('unexpected PING reply');
          },
        },
      ],
    },
    {
      provide: HealthService,
      inject: [HEALTH_PROBES],
      useFactory: (probes: HealthProbe[]) => new HealthService(probes),
    },
  ],
})
export class HealthModule {}
