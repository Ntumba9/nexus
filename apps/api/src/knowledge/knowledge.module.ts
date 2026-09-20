import { Module } from '@nestjs/common';
import type { ApiEnv } from '@nexus/config';
import { createEmbeddingProvider, type EmbeddingProvider } from '@nexus/database';
import type { Redis } from 'ioredis';
import { AuditModule } from '../audit/audit.module';
import { ENV, REDIS } from '../infrastructure/tokens';
import { RateLimiter, RedisRateLimitStore } from '../rate-limit/rate-limiter';
import { RATE_LIMITER } from '../rate-limit/tokens';
import { KnowledgeController } from './knowledge.controller';
import { KnowledgeService } from './knowledge.service';
import { EMBEDDINGS } from './tokens';

@Module({
  imports: [AuditModule],
  controllers: [KnowledgeController],
  providers: [
    KnowledgeService,
    {
      provide: EMBEDDINGS,
      inject: [ENV],
      // Built at startup, so an incomplete EMBEDDING_* configuration fails the boot, not a search.
      useFactory: (env: ApiEnv): EmbeddingProvider =>
        createEmbeddingProvider({
          provider: env.EMBEDDING_PROVIDER,
          apiUrl: env.EMBEDDING_API_URL,
          apiKey: env.EMBEDDING_API_KEY,
          model: env.EMBEDDING_MODEL,
        }),
    },
    {
      provide: RATE_LIMITER,
      inject: [REDIS],
      useFactory: (redis: Redis) => new RateLimiter(new RedisRateLimitStore(redis)),
    },
  ],
})
export class KnowledgeModule {}
