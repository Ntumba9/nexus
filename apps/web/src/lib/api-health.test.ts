import { describe, expect, it } from 'vitest';
import { fetchApiStatus } from './api-health';

const report = {
  status: 'down',
  checks: {
    postgres: { status: 'up', latencyMs: 3 },
    redis: { status: 'down', latencyMs: 2000, error: 'timeout' },
  },
  timestamp: new Date().toISOString(),
};

const respond = (body: unknown, status = 200): typeof fetch =>
  (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;

describe('fetchApiStatus', () => {
  it('parses a 503 body as a report', async () => {
    const result = await fetchApiStatus('http://api', respond(report, 503));
    expect(result.kind).toBe('report');
  });

  it('treats network errors as unreachable', async () => {
    const failing = (async () => {
      throw new Error('ECONNREFUSED');
    }) as typeof fetch;
    expect(await fetchApiStatus('http://api', failing)).toMatchObject({ kind: 'unreachable' });
  });

  it('treats malformed bodies as unreachable', async () => {
    expect(await fetchApiStatus('http://api', respond({ hello: 'world' }))).toMatchObject({
      kind: 'unreachable',
    });
  });
});
