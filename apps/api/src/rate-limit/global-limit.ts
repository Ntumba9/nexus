import { Logger } from '@nestjs/common';
import type { NextFunction, Response } from 'express';
import type { Redis } from 'ioredis';
import { ApiError } from '../common/api-error';
import type { AppRequest } from '../common/request-context';

/** Never limited: probes and scrapes come from infrastructure, and a stream is one long request. */
const EXEMPT = /^\/(?:health\/|metrics$)|\/orgs\/[^/]+\/events$/;

/**
 * A ceiling on requests per client IP per minute across the whole API. It is a backstop for one
 * client hogging the server, not a security control (the credential endpoints have their own, far
 * stricter limits), so it FAILS OPEN: if Redis is unavailable requests are let through rather than
 * the whole API refusing to serve. Raw Express middleware sits outside Nest's exception filters, so
 * it answers directly in the same error envelope.
 */
export function globalRateLimit(redis: Redis, perMinute: number) {
  const logger = new Logger('GlobalRateLimit');
  let warnedAt = 0;
  return async (request: AppRequest, response: Response, next: NextFunction): Promise<void> => {
    if (EXEMPT.test(request.path)) return next();
    const window = Math.floor(Date.now() / 60_000);
    const key = `rl:global:${request.ip ?? 'unknown'}:${window}`;
    try {
      const results = await redis.multi().incr(key).expire(key, 70).exec();
      const count = Number(results?.[0]?.[1]);
      if (Number.isFinite(count) && count > perMinute) {
        const retryAfter = 60 - Math.floor((Date.now() % 60_000) / 1000);
        const error = ApiError.tooManyRequests(retryAfter);
        response
          .status(error.getStatus())
          .setHeader('Retry-After', String(retryAfter))
          .json({ error: { code: error.code, message: error.message, requestId: request.id } });
        return;
      }
    } catch (error) {
      // Fail open, and say so at most once a minute.
      if (Date.now() - warnedAt > 60_000) {
        warnedAt = Date.now();
        logger.warn(
          `Global rate limit unavailable, letting requests through: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    next();
  };
}
