import { describe, expect, it } from 'vitest';
import { REDACTED, redactForAudit } from './audit';

describe('redactForAudit', () => {
  it('keeps ordinary values', () => {
    expect(redactForAudit({ name: 'Rule', enabled: true, count: 3, none: null })).toEqual({
      name: 'Rule',
      enabled: true,
      count: 3,
      none: null,
    });
    expect(redactForAudit(undefined)).toEqual({});
  });

  it.each([
    'secret',
    'webhookSecret',
    'signingSecret',
    'password',
    'passwordHash',
    'token',
    'accessToken',
    'Authorization',
    'x-hub-signature-256',
    'apiKey',
    'api_key',
    'credentials',
    'cookie',
    'privateKey',
  ])('replaces the value of a key called %s, whatever it holds', (key) => {
    expect(redactForAudit({ [key]: 'hunter2', ok: 'fine' })).toEqual({
      [key]: REDACTED,
      ok: 'fine',
    });
    expect(redactForAudit({ [key]: { nested: 'x' } })).toEqual({ [key]: REDACTED });
  });

  it('reaches secrets nested inside objects and arrays', () => {
    const out = redactForAudit({
      rule: { name: 'r', actions: [{ type: 'webhook', secret: 'shh' }] },
    });
    expect(JSON.stringify(out)).not.toContain('shh');
    expect(JSON.stringify(out)).toContain('webhook');
  });

  it('drops the query string and any credentials from URLs', () => {
    const out = redactForAudit({
      url: 'https://user:pw@hooks.example.com/path?token=abc&x=1#frag',
    });
    expect(out.url).toBe('https://hooks.example.com/path');
    expect(JSON.stringify(out)).not.toMatch(/token=|pw|abc/);
    // Looks like a URL but cannot be parsed: it might still hold credentials, so it is not kept.
    expect(redactForAudit({ url: 'http://[not a url' }).url).toBe(REDACTED);
  });

  it('bounds strings, arrays, keys and depth', () => {
    const out = redactForAudit({
      long: 'x'.repeat(1000),
      list: Array.from({ length: 100 }, (_, i) => i),
      deep: { a: { b: { c: { d: 'too deep' } } } },
      ...Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`k${i}`, i])),
    });
    expect((out.long as string).length).toBeLessThanOrEqual(301);
    expect(out.list as unknown[]).toHaveLength(20);
    expect(JSON.stringify(out.deep)).toContain('[truncated]');
    expect(Object.keys(out).length).toBeLessThanOrEqual(30);
  });

  it('drops functions and undefined, and turns non-finite numbers into null', () => {
    const out = redactForAudit({
      fn: () => 1,
      u: undefined,
      nan: Number.NaN,
      inf: Infinity,
      ok: 1,
    });
    expect(out).toEqual({ fn: null, nan: null, inf: null, ok: 1 });
  });

  it('never mutates its input', () => {
    const input = { secret: 'shh', nested: { token: 't' } };
    redactForAudit(input);
    expect(input).toEqual({ secret: 'shh', nested: { token: 't' } });
  });
});
