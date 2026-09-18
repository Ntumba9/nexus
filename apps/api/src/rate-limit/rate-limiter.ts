import { createHash } from 'node:crypto';
import { Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { ApiError } from '../common/api-error';

export interface RateLimitHit {
  count: number;
  retryAfterSeconds: number;
}

/** Counter storage boundary so the limiter can be unit-tested without Redis. */
export interface RateLimitStore {
  /** Increment the counter for `key` (creating it with a TTL of `windowSeconds`). */
  hit(key: string, windowSeconds: number): Promise<RateLimitHit>;
}

export class RedisRateLimitStore implements RateLimitStore {
  constructor(private readonly redis: Redis) {}

  async hit(key: string, windowSeconds: number): Promise<RateLimitHit> {
    const results = await this.redis.multi().incr(key).ttl(key).exec();
    const count = Number(results?.[0]?.[1]);
    let ttl = Number(results?.[1]?.[1]);
    if (!Number.isFinite(count) || !Number.isFinite(ttl)) throw new Error('unexpected Redis reply');
    // TTL < 0 means the key has no expiry (first hit, or a crash between INCR and EXPIRE).
    if (ttl < 0) {
      await this.redis.expire(key, windowSeconds);
      ttl = windowSeconds;
    }
    return { count, retryAfterSeconds: ttl };
  }
}

/** Fixed-window limiter. Identifiers are hashed so no PII (emails, IPs) is stored in Redis keys. */
export class RateLimiter {
  private readonly logger = new Logger('RateLimiter');

  constructor(private readonly store: RateLimitStore) {}

  /**
   * Count one attempt for (scope, identifier); throws 429 once `limit` is exceeded within the window.
   * Fails closed: if the store is unavailable the request is refused rather than left unlimited,
   * because these limits protect credential endpoints.
   */
  async consume(
    scope: string,
    identifier: string,
    limit: number,
    windowSeconds: number,
  ): Promise<void> {
    const key = `rl:${scope}:${createHash('sha256').update(identifier).digest('hex').slice(0, 32)}`;
    let hit: RateLimitHit;
    try {
      hit = await this.store.hit(key, windowSeconds);
    } catch (error) {
      this.logger.error(
        `Rate limit store failure: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw ApiError.unavailable('RATE_LIMIT_UNAVAILABLE', 'Service temporarily unavailable');
    }
    if (hit.count > limit) throw ApiError.tooManyRequests(hit.retryAfterSeconds);
  }
}
