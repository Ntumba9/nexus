import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, HAS_INFRA, createTestApp, type TestApp } from '../testing/harness';

describe.skipIf(!HAS_INFRA)('API hardening (integration)', () => {
  let t: TestApp;
  beforeAll(async () => {
    // The smallest allowed ceiling, so the limit can be reached in a test.
    t = await createTestApp({ env: { API_RATE_LIMIT_PER_MINUTE: '60', METRICS_TOKEN: '' } });
  });
  afterAll(() => t.close());

  describe('response headers', () => {
    it('lets nothing be loaded, framed or embedded from an API response', async () => {
      const res = await new Client(t.server).get('/auth/me');
      expect(res.status).toBe(401);
      const csp = String(res.headers['content-security-policy']);
      expect(csp).toContain("default-src 'none'");
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).not.toMatch(/unsafe-inline|unsafe-eval|\*/);
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['referrer-policy']).toBe('no-referrer');
      expect(res.headers['strict-transport-security']).toBe('max-age=63072000; includeSubDomains');
    });

    it('does not say what it is built with, and gives every response a request id', async () => {
      const res = await new Client(t.server).get('/auth/me');
      expect(res.headers['x-powered-by']).toBeUndefined();
      expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('sends the same headers on errors as on successes', async () => {
      const res = await new Client(t.server).get('/definitely/not/here');
      expect(res.status).toBe(404);
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['content-security-policy']).toBeTruthy();
    });
  });

  describe('global request limit', () => {
    it('answers 429 with Retry-After in the error envelope once a client goes over, for that client only', async () => {
      const noisy = new Client(t.server);
      let last = 0;
      let body: { error?: { code?: string; requestId?: string } } = {};
      let retryAfter = '';
      // The window is a wall-clock minute, so a run that straddles two windows can send 60 in each
      // without going over: 125 requests guarantee that one window exceeds 60.
      for (let i = 0; i < 125; i += 1) {
        const res = await noisy.get('/auth/me');
        last = res.status;
        if (res.status === 429) {
          body = res.body;
          retryAfter = String(res.headers['retry-after']);
          break;
        }
      }
      expect(last).toBe(429);
      expect(body.error?.requestId).toBeTruthy();
      expect(Number(retryAfter)).toBeGreaterThan(0);

      // A different client is not affected.
      expect((await new Client(t.server).get('/auth/me')).status).toBe(401);
    }, 60_000);

    it('never limits the health probes', async () => {
      const prober = new Client(t.server);
      for (let i = 0; i < 80; i += 1) {
        expect((await prober.get('/health/live')).status).toBe(200);
      }
    }, 60_000);
  });
});
