import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import type { ApiEnv } from '@nexus/config';
import type { PrismaClient } from '@nexus/database';
import type { Redis } from 'ioredis';
import { ENV, PRISMA, REDIS } from '../infrastructure/tokens';
import { RateLimiter, RedisRateLimitStore } from '../rate-limit/rate-limiter';
import { RATE_LIMITER } from '../rate-limit/tokens';
import { OrgAccessGuard } from '../rbac/org-access.guard';
import { AuthRateLimits } from './auth-rate-limits';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { PasswordService } from './password.service';
import { PrismaSessionStore } from './prisma-session.store';
import { SESSION_STORE, SessionService, type SessionStore } from './session.service';
import { SessionGuard } from './session.guard';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

@Module({
  controllers: [AuthController],
  providers: [
    PasswordService,
    AuthService,
    AuthRateLimits,
    {
      provide: SESSION_STORE,
      inject: [PRISMA],
      useFactory: (prisma: PrismaClient) => new PrismaSessionStore(prisma),
    },
    {
      provide: SessionService,
      inject: [SESSION_STORE, ENV],
      useFactory: (store: SessionStore, env: ApiEnv) =>
        new SessionService(store, {
          idleMs: env.SESSION_IDLE_TTL_HOURS * HOUR_MS,
          absoluteMs: env.SESSION_ABSOLUTE_TTL_DAYS * DAY_MS,
          touchIntervalMs: 5 * 60_000,
        }),
    },
    {
      provide: RATE_LIMITER,
      inject: [REDIS],
      useFactory: (redis: Redis) => new RateLimiter(new RedisRateLimitStore(redis)),
    },
    // Order matters: authenticate first, then authorise against the route's organisation.
    { provide: APP_GUARD, useClass: SessionGuard },
    { provide: APP_GUARD, useClass: OrgAccessGuard },
  ],
  exports: [SessionService],
})
export class AuthModule {}
