import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import type { Redis } from 'ioredis';
import { RateLimiter, RedisRateLimitStore } from '../rate-limit/rate-limiter';
import { RATE_LIMITER } from '../rate-limit/tokens';
import { REDIS } from '../infrastructure/tokens';
import { DeploymentsService } from './deployments.service';
import { GitHubController } from './github.controller';
import { GitHubIntegrationsService } from './github-integrations.service';
import { GitHubWebhookController } from './github-webhook.controller';
import { GitHubWebhookService } from './github-webhook.service';

@Module({
  imports: [AuditModule],
  controllers: [GitHubController, GitHubWebhookController],
  providers: [
    GitHubIntegrationsService,
    GitHubWebhookService,
    DeploymentsService,
    {
      provide: RATE_LIMITER,
      inject: [REDIS],
      useFactory: (redis: Redis) => new RateLimiter(new RedisRateLimitStore(redis)),
    },
  ],
})
export class GitHubModule {}
