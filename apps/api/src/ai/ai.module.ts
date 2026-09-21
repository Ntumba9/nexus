import { Module } from '@nestjs/common';
import type { ApiEnv } from '@nexus/config';
import { createAnalysisProvider, type AnalysisProvider } from '@nexus/database';
import type { Redis } from 'ioredis';
import { AuditModule } from '../audit/audit.module';
import { ENV, REDIS } from '../infrastructure/tokens';
import { RateLimiter, RedisRateLimitStore } from '../rate-limit/rate-limiter';
import { RATE_LIMITER } from '../rate-limit/tokens';
import { AiController } from './ai.controller';
import { AiService } from './ai.service';
import { ANALYSIS } from './tokens';

@Module({
  imports: [AuditModule],
  controllers: [AiController],
  providers: [
    AiService,
    {
      provide: ANALYSIS,
      inject: [ENV],
      // Built at startup, so an incomplete AI_* configuration fails the boot, not a request.
      useFactory: (env: ApiEnv): AnalysisProvider | null =>
        createAnalysisProvider({
          provider: env.AI_PROVIDER,
          apiUrl: env.AI_API_URL,
          apiKey: env.AI_API_KEY,
          model: env.AI_MODEL,
          vendor: env.AI_VENDOR,
        }),
    },
    {
      provide: RATE_LIMITER,
      inject: [REDIS],
      useFactory: (redis: Redis) => new RateLimiter(new RedisRateLimitStore(redis)),
    },
  ],
})
export class AiModule {}
