import { describe, expect, it } from 'vitest';
import { createSafeLookup, isBlockedAddress, validateMonitoringUrl } from './net-safety';

describe('isBlockedAddress', () => {
  it.each([
    // loopback, private, link-local (incl. cloud metadata), CGNAT
    ['127.0.0.1', true],
    ['127.255.255.254', true],
    ['10.0.0.1', true],
    ['172.16.0.1', true],
    ['172.31.255.255', true],
    ['192.168.1.1', true],
    ['169.254.169.254', true],
    ['100.64.0.1', true],
    ['0.0.0.0', true],
    ['224.0.0.1', true],
    ['255.255.255.255', true],
    // boundaries: just outside the private ranges is public
    ['172.15.255.255', false],
    ['172.32.0.0', false],
    ['11.0.0.0', false],
    ['100.63.255.255', false],
    ['100.128.0.0', false],
    ['192.169.0.1', false],
    // ordinary public addresses
    ['8.8.8.8', false],
    ['1.1.1.1', false],
    ['93.184.216.34', false],
    // IPv6
    ['::1', true],
    ['::', true],
    ['fe80::1', true],
    ['fc00::1', true],
    ['fd12:3456::1', true],
    ['ff02::1', true],
    ['2001:db8::1', true],
    ['64:ff9b::7f00:1', true],
    ['2606:4700:4700::1111', false],
    ['2001:4860:4860::8888', false],
    // IPv4-mapped IPv6 must be judged by the embedded IPv4
    ['::ffff:127.0.0.1', true],
    ['::ffff:7f00:1', true],
    ['::ffff:169.254.169.254', true],
    ['::ffff:10.1.2.3', true],
    ['::ffff:8.8.8.8', false],
    ['::ffff:808:808', false],
  ])('%s → blocked=%s', (address, blocked) => {
    expect(isBlockedAddress(address)).toBe(blocked);
  });

  it('fails closed on anything that is not an IP literal', () => {
    for (const value of [
      '',
      'localhost',
      'example.com',
      '999.1.1.1',
      '1.2.3',
      'not an ip',
      '127.0.0.1/8',
    ]) {
      expect(isBlockedAddress(value), value).toBe(true);
    }
  });
});

describe('validateMonitoringUrl (public only)', () => {
  const strict = { allowPrivate: false };

  it('accepts ordinary public http(s) URLs', () => {
    for (const url of [
      'https://example.com/health',
      'http://api.example.com:8080/x?y=1',
      'https://8.8.8.8/',
    ]) {
      expect(validateMonitoringUrl(url, strict).ok, url).toBe(true);
    }
  });

  it('rejects other schemes', () => {
    for (const url of [
      'ftp://example.com',
      'file:///etc/passwd',
      'gopher://example.com',
      'javascript:alert(1)',
      'data:text/plain,hi',
    ]) {
      expect(validateMonitoringUrl(url, strict).ok, url).toBe(false);
    }
  });

  it('rejects credentials in the URL', () => {
    expect(validateMonitoringUrl('https://user:pass@example.com', strict).ok).toBe(false);
    expect(validateMonitoringUrl('https://user@example.com', strict).ok).toBe(false);
  });

  it('rejects private and internal literal addresses, including disguised encodings', () => {
    for (const url of [
      'http://127.0.0.1/',
      'http://10.0.0.5:9000/',
      'http://192.168.0.1/',
      'http://169.254.169.254/latest/meta-data/',
      'http://[::1]/',
      'http://[fe80::1]/',
      'http://[::ffff:127.0.0.1]/',
      'http://0.0.0.0/',
      'http://2130706433/', // decimal form of 127.0.0.1
      'http://0x7f000001/', // hex form
      'http://0177.0.0.1/', // octal form
      'http://127.1/', // shorthand
    ]) {
      expect(validateMonitoringUrl(url, strict).ok, url).toBe(false);
    }
  });

  it('rejects internal hostnames and single-label hosts', () => {
    for (const url of [
      'http://localhost/',
      'http://LOCALHOST:3001/',
      'http://app.localhost/',
      'http://db.internal/',
      'http://printer.local/',
      'http://router.lan/',
      'http://intranet/',
      'http://localhost./', // trailing-dot FQDN form of localhost
      'http://db.internal./',
      'http://127.0.0.1./',
    ]) {
      expect(validateMonitoringUrl(url, strict).ok, url).toBe(false);
    }
  });

  it('rejects malformed input with a helpful message and does not throw', () => {
    for (const url of ['', 'not a url', 'http://', '://x', 'http://exa mple.com']) {
      const result = validateMonitoringUrl(url, strict);
      expect(result.ok, url).toBe(false);
    }
  });

  it('allows private targets only with the explicit operator opt-in, but never other schemes or credentials', () => {
    const open = { allowPrivate: true };
    expect(validateMonitoringUrl('http://127.0.0.1:3001/health', open).ok).toBe(true);
    expect(validateMonitoringUrl('http://localhost:4100/', open).ok).toBe(true);
    expect(validateMonitoringUrl('ftp://127.0.0.1/', open).ok).toBe(false);
    expect(validateMonitoringUrl('http://user:pw@127.0.0.1/', open).ok).toBe(false);
  });
});

describe('createSafeLookup', () => {
  const call = (host: string, options: { allowPrivate: boolean }, lookupOptions: object = {}) =>
    new Promise<{ error: NodeJS.ErrnoException | null; address: unknown }>((resolve) => {
      createSafeLookup(options)(host, lookupOptions, (error, address) =>
        resolve({ error, address }),
      );
    });

  it('refuses a hostname that resolves to a private address, and never hands out that address', async () => {
    const result = await call('localhost', { allowPrivate: false });
    expect(result.error).not.toBeNull();
    expect(result.error?.name).toBe('BlockedAddressError');
    expect(result.address).toBe('');
  });

  it('refuses a literal private IP the same way', async () => {
    expect((await call('127.0.0.1', { allowPrivate: false })).error?.name).toBe(
      'BlockedAddressError',
    );
    expect((await call('169.254.169.254', { allowPrivate: false })).error?.name).toBe(
      'BlockedAddressError',
    );
  });

  it('with the operator opt-in it returns the address (single form and the array form Node uses)', async () => {
    const single = await call('127.0.0.1', { allowPrivate: true });
    expect(single.error).toBeNull();
    expect(single.address).toBe('127.0.0.1');
    const all = await call('127.0.0.1', { allowPrivate: true }, { all: true });
    expect(all.error).toBeNull();
    expect(all.address).toEqual([{ address: '127.0.0.1', family: 4 }]);
  });

  it('reports DNS failures as an error, not as an allowed address', async () => {
    const result = await call('does-not-exist.invalid', { allowPrivate: false });
    expect(result.error).not.toBeNull();
    expect(result.error?.name).not.toBe('BlockedAddressError');
  });
});
