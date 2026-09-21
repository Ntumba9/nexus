import { describe, expect, it } from 'vitest';
import { HTTP_BUCKETS, MetricsRegistry, bearerMatches, statusClass } from './metrics';

describe('MetricsRegistry', () => {
  it('renders counters with sorted, escaped labels', async () => {
    const registry = new MetricsRegistry();
    const requests = registry.counter('http_requests_total', 'Requests.');
    requests.inc({ method: 'GET', route: '/a"b\\c\nd' });
    requests.inc({ method: 'GET', route: '/a"b\\c\nd' }, 2);
    requests.inc({ route: '/x', method: 'POST' });
    const text = await registry.render();
    expect(text).toContain('# TYPE http_requests_total counter');
    expect(text).toContain('http_requests_total{method="GET",route="/a\\"b\\\\c\\nd"} 3');
    expect(text).toContain('http_requests_total{method="POST",route="/x"} 1');
  });

  it('renders cumulative histogram buckets, a +Inf bucket, sum and count', async () => {
    const registry = new MetricsRegistry();
    const latency = registry.histogram('latency_seconds', 'Latency.', [0.1, 1]);
    latency.observe(0.05, { route: '/a' });
    latency.observe(0.5, { route: '/a' });
    latency.observe(5, { route: '/a' });
    const text = await registry.render();
    expect(text).toContain('latency_seconds_bucket{route="/a",le="0.1"} 1');
    expect(text).toContain('latency_seconds_bucket{route="/a",le="1"} 2');
    expect(text).toContain('latency_seconds_bucket{route="/a",le="+Inf"} 3');
    expect(text).toContain('latency_seconds_sum{route="/a"} 5.55');
    expect(text).toContain('latency_seconds_count{route="/a"} 3');
  });

  it('reads gauges at scrape time and skips one that fails or is not finite', async () => {
    const registry = new MetricsRegistry();
    let open = 2;
    registry.gauge({ name: 'connections', help: 'Open.', read: () => open });
    registry.gauge({ name: 'broken', help: 'Fails.', read: () => Promise.reject(new Error('no')) });
    registry.gauge({ name: 'nan', help: 'Not a number.', read: () => Number.NaN });
    expect(await registry.render()).toContain('connections 2');
    open = 7;
    const text = await registry.render();
    expect(text).toContain('connections 7');
    expect(text).not.toMatch(/broken|nan /);
  });

  it('refuses invalid metric and label names', () => {
    const registry = new MetricsRegistry();
    expect(() => registry.counter('bad name', 'x')).toThrow();
    expect(() => registry.counter('ok', 'x').inc({ 'bad-label': 'v' })).toThrow();
  });

  it('caps how many label combinations one metric can hold', async () => {
    const registry = new MetricsRegistry();
    const counter = registry.counter('c_total', 'x');
    for (let i = 0; i < 2000; i += 1) counter.inc({ id: String(i) });
    const series = (await registry.render()).split('\n').filter((l) => l.startsWith('c_total{'));
    expect(series.length).toBe(500);
  });

  it('turns status codes into a small set of classes', () => {
    expect([200, 204, 302, 404, 429, 503].map(statusClass)).toEqual([
      '2xx',
      '2xx',
      '3xx',
      '4xx',
      '4xx',
      '5xx',
    ]);
    expect(HTTP_BUCKETS[0]).toBe(0.005);
  });
});

describe('bearerMatches', () => {
  it('accepts only the exact token, and never an empty one', () => {
    expect(bearerMatches('Bearer secret-token-123', 'secret-token-123')).toBe(true);
    for (const bad of [
      undefined,
      '',
      'Bearer',
      'Bearer ',
      'Bearer secret-token-124',
      'secret-token-123',
      'bearer secret-token-123',
      'Bearer secret-token-1234',
    ]) {
      expect(bearerMatches(bad, 'secret-token-123'), String(bad)).toBe(false);
    }
    expect(bearerMatches('Bearer ', '')).toBe(false);
  });
});
