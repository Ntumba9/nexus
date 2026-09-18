import { describe, expect, it } from 'vitest';
import { ApiError } from '../common/api-error';
import { RateLimiter, type RateLimitStore } from './rate-limiter';

class MemoryStore implements RateLimitStore {
  counts = new Map<string, number>();
  keys: string[] = [];
  async hit(key: string) {
    this.keys.push(key);
    const count = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, count);
    return { count, retryAfterSeconds: 42 };
  }
}

describe('RateLimiter', () => {
  it('allows up to the limit then throws 429 with Retry-After', async () => {
    const limiter = new RateLimiter(new MemoryStore());
    for (let i = 0; i < 3; i++) await limiter.consume('login', 'a@example.com', 3, 60);
    const error = await limiter.consume('login', 'a@example.com', 3, 60).catch((e) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error.getStatus()).toBe(429);
    expect(error.headers).toEqual({ 'Retry-After': '42' });
  });

  it('tracks identifiers and scopes independently', async () => {
    const limiter = new RateLimiter(new MemoryStore());
    await limiter.consume('login', 'a@example.com', 1, 60);
    await expect(limiter.consume('login', 'b@example.com', 1, 60)).resolves.toBeUndefined();
    await expect(limiter.consume('register', 'a@example.com', 1, 60)).resolves.toBeUndefined();
  });

  it('never puts the raw identifier in the storage key', async () => {
    const store = new MemoryStore();
    await new RateLimiter(store).consume('login', 'victim@example.com', 5, 60);
    expect(store.keys[0]).not.toContain('victim');
    expect(store.keys[0]).toMatch(/^rl:login:[0-9a-f]{32}$/);
  });

  it('fails closed with 503 when the store is unavailable', async () => {
    const broken: RateLimitStore = {
      hit: async () => {
        throw new Error('redis down');
      },
    };
    const error = await new RateLimiter(broken).consume('login', 'x', 5, 60).catch((e) => e);
    expect(error.getStatus()).toBe(503);
    expect(error.message).not.toContain('redis');
  });
});
