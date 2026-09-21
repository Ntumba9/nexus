import { describe, expect, it } from 'vitest';
import { HSTS, STATIC_SECURITY_HEADERS, buildCsp, newNonce } from './csp';

const directive = (csp: string, name: string) =>
  csp
    .split('; ')
    .find((d) => d.startsWith(`${name} `) || d === name)
    ?.split(' ')
    .slice(1) ?? null;

describe('buildCsp', () => {
  const prod = buildCsp({ nonce: 'abc123==', development: false, https: true });

  it('allows scripts and styles only with this request’s nonce, and never inline or eval in production', () => {
    expect(directive(prod, 'script-src')).toEqual([
      "'self'",
      "'nonce-abc123=='",
      "'strict-dynamic'",
    ]);
    expect(directive(prod, 'style-src')).toEqual(["'self'", "'nonce-abc123=='"]);
    expect(prod).not.toMatch(/unsafe-inline|unsafe-eval/);
  });

  it('forbids framing, plugins, foreign form targets and a rewritten base', () => {
    expect(directive(prod, 'frame-ancestors')).toEqual(["'none'"]);
    expect(directive(prod, 'object-src')).toEqual(["'none'"]);
    expect(directive(prod, 'base-uri')).toEqual(["'self'"]);
    expect(directive(prod, 'form-action')).toEqual(["'self'"]);
  });

  it('lets the page talk only to its own origin', () => {
    expect(directive(prod, 'default-src')).toEqual(["'self'"]);
    expect(directive(prod, 'connect-src')).toEqual(["'self'"]);
    expect(prod).not.toMatch(/https?:\/\/|\*/);
  });

  it('upgrades insecure requests only over HTTPS, so http://localhost still works', () => {
    expect(prod).toContain('upgrade-insecure-requests');
    expect(buildCsp({ nonce: 'n', development: false, https: false })).not.toContain(
      'upgrade-insecure-requests',
    );
  });

  it('relaxes eval and inline styles for `next dev` only', () => {
    const dev = buildCsp({ nonce: 'n', development: true, https: false });
    expect(dev).toContain("'unsafe-eval'");
    expect(dev).toContain("'unsafe-inline'");
  });
});

describe('newNonce', () => {
  it('is unpredictable: unique, base64 and long enough', () => {
    const nonces = new Set(Array.from({ length: 200 }, newNonce));
    expect(nonces.size).toBe(200);
    for (const nonce of nonces) expect(nonce).toMatch(/^[A-Za-z0-9+/]{22}==$/);
  });
});

describe('static headers', () => {
  it('cover sniffing, framing, referrers, powerful features and cross-origin isolation', () => {
    expect(STATIC_SECURITY_HEADERS).toMatchObject({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Resource-Policy': 'same-origin',
    });
    expect(STATIC_SECURITY_HEADERS['Permissions-Policy']).toContain('camera=()');
  });
  it('HSTS is two years and covers subdomains', () => {
    expect(HSTS).toBe('max-age=63072000; includeSubDomains');
  });
});
