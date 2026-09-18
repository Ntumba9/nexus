import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { HealthController } from './health.controller';
import { HealthService, type HealthProbe } from './health.service';

const up: HealthProbe = { name: 'postgres', check: async () => undefined };
const down: HealthProbe = {
  name: 'redis',
  check: async () => {
    throw new Error('connect ECONNREFUSED 10.0.0.5:6379 password=hunter2');
  },
};
const hung: HealthProbe = { name: 'slow', check: () => new Promise(() => undefined) };

describe('HealthService', () => {
  it('reports ok when every probe is up', async () => {
    const report = await new HealthService([up]).readiness();
    expect(report.status).toBe('ok');
    expect(report.checks.postgres?.status).toBe('up');
  });

  it('reports down with a coarse reason and no internal details', async () => {
    const report = await new HealthService([up, down]).readiness();
    expect(report.status).toBe('down');
    expect(report.checks.redis).toMatchObject({ status: 'down', error: 'unavailable' });
    expect(JSON.stringify(report)).not.toContain('hunter2');
  });

  it('times out hung probes', async () => {
    const report = await new HealthService([hung], 20).readiness();
    expect(report.checks.slow).toMatchObject({ status: 'down', error: 'timeout' });
  });
});

describe('GET /health', () => {
  let app: INestApplication | undefined;

  async function boot(probes: HealthProbe[]): Promise<INestApplication> {
    const moduleRef = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [{ provide: HealthService, useValue: new HealthService(probes) }],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    return app;
  }

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('live returns 200', async () => {
    const server = (await boot([down])).getHttpServer();
    const res = await request(server).get('/health/live');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('ready returns 200 when healthy', async () => {
    const server = (await boot([up])).getHttpServer();
    const res = await request(server).get('/health/ready');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  it('ready returns 503 with the report when a dependency is down', async () => {
    const server = (await boot([up, down])).getHttpServer();
    const res = await request(server).get('/health/ready');
    expect(res.status).toBe(503);
    expect(res.body.checks.redis.status).toBe('down');
  });
});
