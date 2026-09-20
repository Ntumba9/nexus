import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startHealthServer, type ReadinessProbe } from './health-server';
import type { Logger } from './logger';

const logger: Logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const servers: Server[] = [];

async function start(options: {
  probes?: ReadinessProbe[];
  metrics?: { token: string; render: () => Promise<string> };
}) {
  const server = startHealthServer(
    { host: '127.0.0.1', port: 0, probes: options.probes ?? [], metrics: options.metrics },
    logger,
  );
  servers.push(server);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return (path: string, init?: RequestInit) => fetch(base + path, init);
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
  vi.clearAllMocks();
});

describe('worker health server', () => {
  it('reports liveness without touching any dependency', async () => {
    const probe = vi.fn().mockRejectedValue(new Error('down'));
    const get = await start({ probes: [{ name: 'redis', check: probe }] });
    const res = await get('/health/live');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
    expect(probe).not.toHaveBeenCalled();
  });

  it('is ready only when every dependency is up', async () => {
    const get = await start({
      probes: [
        { name: 'redis', check: async () => 1 },
        { name: 'postgres', check: async () => 1 },
      ],
    });
    const res = await get('/health/ready');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: 'ok',
      checks: { redis: { status: 'up' }, postgres: { status: 'up' } },
    });
  });

  it('is not ready when one dependency is down, and does not leak why', async () => {
    const get = await start({
      probes: [
        { name: 'redis', check: async () => 1 },
        {
          name: 'postgres',
          check: async () => {
            throw new Error('password authentication failed');
          },
        },
      ],
    });
    const res = await get('/health/ready');
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body).toEqual({
      status: 'down',
      checks: { redis: { status: 'up' }, postgres: { status: 'down' } },
    });
    expect(JSON.stringify(body)).not.toContain('password');
    expect(logger.warn).toHaveBeenCalledWith(
      'readiness check failed',
      expect.objectContaining({ probe: 'postgres' }),
    );
  });

  it('refuses anything but GET, and unknown paths', async () => {
    const get = await start({});
    expect((await get('/health/live', { method: 'POST' })).status).toBe(405);
    expect((await get('/nope')).status).toBe(404);
  });

  describe('/metrics', () => {
    const auth = { authorization: 'Bearer secret-token-value' };

    it('does not exist without a configured token', async () => {
      const get = await start({});
      expect((await get('/metrics')).status).toBe(404);
    });

    it('requires the bearer token', async () => {
      const render = vi.fn().mockResolvedValue('nexus_up 1\n');
      const get = await start({ metrics: { token: 'secret-token-value', render } });
      expect((await get('/metrics')).status).toBe(401);
      expect((await get('/metrics', { headers: { authorization: 'Bearer wrong' } })).status).toBe(
        401,
      );
      expect(render).not.toHaveBeenCalled();
    });

    it('serves the text format, uncached, to the right token', async () => {
      const get = await start({
        metrics: { token: 'secret-token-value', render: async () => 'nexus_up 1\n' },
      });
      const res = await get('/metrics', { headers: auth });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/plain');
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(await res.text()).toBe('nexus_up 1\n');
    });

    it('answers 500 without details when rendering fails', async () => {
      const get = await start({
        metrics: {
          token: 'secret-token-value',
          render: async () => {
            throw new Error('internal detail');
          },
        },
      });
      const res = await get('/metrics', { headers: auth });
      expect(res.status).toBe(500);
      expect(await res.text()).not.toContain('internal detail');
    });
  });
});
