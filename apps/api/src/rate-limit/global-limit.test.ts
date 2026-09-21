import type { NextFunction, Response } from 'express';
import type { Redis } from 'ioredis';
import { describe, expect, it, vi } from 'vitest';
import type { AppRequest } from '../common/request-context';
import { globalRateLimit } from './global-limit';

/** A Redis stand-in: `multi().incr().expire().exec()` with a per-key counter. */
function fakeRedis(behaviour: 'ok' | 'down' = 'ok') {
  const counts = new Map<string, number>();
  return {
    counts,
    redis: {
      multi: () => {
        let key = '';
        const chain = {
          incr(k: string) {
            key = k;
            return chain;
          },
          expire() {
            return chain;
          },
          async exec() {
            if (behaviour === 'down') throw new Error('Connection is closed.');
            counts.set(key, (counts.get(key) ?? 0) + 1);
            return [
              [null, counts.get(key)],
              [null, 1],
            ];
          },
        };
        return chain;
      },
    } as unknown as Redis,
  };
}

function run(middleware: ReturnType<typeof globalRateLimit>, path: string, ip = '1.2.3.4') {
  const headers: Record<string, string> = {};
  let status = 200;
  let body: unknown;
  const response = {
    status(code: number) {
      status = code;
      return response;
    },
    setHeader(name: string, value: string) {
      headers[name] = value;
      return response;
    },
    json(payload: unknown) {
      body = payload;
    },
  } as unknown as Response;
  const next = vi.fn();
  const request = { path, ip, id: 'req-1' } as unknown as AppRequest;
  return middleware(request, response, next as unknown as NextFunction).then(() => ({
    next,
    status,
    headers,
    body,
  }));
}

describe('globalRateLimit', () => {
  it('lets requests through up to the limit, then answers 429 in the error envelope with Retry-After', async () => {
    const { redis } = fakeRedis();
    const limit = globalRateLimit(redis, 3);
    for (let i = 0; i < 3; i += 1)
      expect((await run(limit, '/api/v1/orgs')).next).toHaveBeenCalled();
    const over = await run(limit, '/api/v1/orgs');
    expect(over.next).not.toHaveBeenCalled();
    expect(over.status).toBe(429);
    expect(Number(over.headers['Retry-After'])).toBeGreaterThan(0);
    expect(over.body).toMatchObject({ error: { code: expect.any(String), requestId: 'req-1' } });
  });

  it('counts each client address separately', async () => {
    const { redis } = fakeRedis();
    const limit = globalRateLimit(redis, 1);
    await run(limit, '/x', '10.0.0.1');
    expect((await run(limit, '/x', '10.0.0.1')).status).toBe(429);
    expect((await run(limit, '/x', '10.0.0.2')).status).toBe(200);
  });

  it('never counts health probes, metrics scrapes or the live stream', async () => {
    const { redis, counts } = fakeRedis();
    const limit = globalRateLimit(redis, 1);
    for (const path of ['/health/live', '/health/ready', '/metrics', '/api/v1/orgs/abc/events']) {
      for (let i = 0; i < 5; i += 1) expect((await run(limit, path)).next).toHaveBeenCalled();
    }
    expect(counts.size).toBe(0);
  });

  it('fails open when Redis is unavailable: the request goes through', async () => {
    const { redis } = fakeRedis('down');
    const limit = globalRateLimit(redis, 1);
    for (let i = 0; i < 5; i += 1) {
      const result = await run(limit, '/api/v1/orgs');
      expect(result.next).toHaveBeenCalled();
      expect(result.status).toBe(200);
    }
  });
});
