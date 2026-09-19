import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { classifyError, createHttpChecker } from './http-checker';

/** A local target whose behaviour depends on the path, and which counts what it received. */
let server: http.Server;
let base: string;
const hits: string[] = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    hits.push(req.url ?? '');
    switch (req.url) {
      case '/ok':
        res.writeHead(200).end('fine');
        break;
      case '/no-content':
        res.writeHead(204).end();
        break;
      case '/error':
        res.writeHead(500).end('boom');
        break;
      case '/redirect':
        res.writeHead(302, { location: `${base}/final` }).end();
        break;
      case '/final':
        res.writeHead(200).end('followed');
        break;
      case '/slow':
        break; // never answer: the checker's deadline must fire
      case '/big':
        res.writeHead(200);
        res.write('x'.repeat(1_000_000));
        break; // never ends: the checker must not wait for the body
      default:
        res.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.closeAllConnections();
  server.close();
});

const open = createHttpChecker({ allowPrivate: true });
const strict = createHttpChecker({ allowPrivate: false });
const target = (
  path: string,
  extra: Partial<{ timeoutMs: number; expectedStatus: number }> = {},
) => ({
  url: `${base}${path}`,
  timeoutMs: 2000,
  expectedStatus: 200,
  ...extra,
});

describe('createHttpChecker', () => {
  it('reports UP with the status code and a response time when the status matches', async () => {
    const result = await open(target('/ok'));
    expect(result).toMatchObject({ status: 'UP', statusCode: 200, failureReason: null });
    expect(result.responseTimeMs).toBeGreaterThanOrEqual(0);
  });

  it('honours the expected status code (in both directions)', async () => {
    expect((await open(target('/no-content', { expectedStatus: 204 }))).status).toBe('UP');
    expect(await open(target('/ok', { expectedStatus: 204 }))).toMatchObject({
      status: 'DOWN',
      statusCode: 200,
      failureReason: 'unexpected_status',
    });
  });

  it('reports DOWN with the status code for server errors', async () => {
    expect(await open(target('/error'))).toMatchObject({
      status: 'DOWN',
      statusCode: 500,
      failureReason: 'unexpected_status',
    });
  });

  it('never follows redirects (so a public URL cannot bounce us to an internal one)', async () => {
    hits.length = 0;
    const result = await open(target('/redirect'));
    expect(result).toMatchObject({
      status: 'DOWN',
      statusCode: 302,
      failureReason: 'unexpected_status',
    });
    expect(hits).toEqual(['/redirect']); // /final was never requested
  });

  it('enforces the deadline when the target never answers', async () => {
    const started = Date.now();
    const result = await open(target('/slow', { timeoutMs: 300 }));
    expect(result).toMatchObject({ status: 'DOWN', failureReason: 'timeout', statusCode: null });
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('decides on headers alone: it neither reads nor waits for an endless body', async () => {
    const started = Date.now();
    const result = await open(target('/big', { timeoutMs: 5000 }));
    expect(result.status).toBe('UP');
    expect(Date.now() - started).toBeLessThan(2500);
  });

  it('reports a refused connection', async () => {
    const closed = http.createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const { port } = closed.address() as AddressInfo;
    await new Promise((resolve) => closed.close(resolve));
    const result = await open({
      url: `http://127.0.0.1:${port}/`,
      timeoutMs: 1000,
      expectedStatus: 200,
    });
    expect(result).toMatchObject({ status: 'DOWN', failureReason: 'connection_refused' });
  });

  it('reports DNS failures', async () => {
    const result = await strict({
      url: 'http://does-not-exist.invalid/',
      timeoutMs: 3000,
      expectedStatus: 200,
    });
    expect(result).toMatchObject({ status: 'DOWN', failureReason: 'dns_failure' });
  });

  it('reports malformed and non-http URLs without throwing', async () => {
    for (const url of [
      'not a url',
      'ftp://example.com/',
      'file:///etc/passwd',
      'http://user:pw@example.com/',
    ]) {
      expect(await open({ url, timeoutMs: 500, expectedStatus: 200 }), url).toMatchObject({
        status: 'DOWN',
        failureReason: 'invalid_url',
      });
    }
  });

  describe('SSRF: with private networks NOT allowed', () => {
    it('refuses private targets and sends them NO request at all', async () => {
      hits.length = 0;
      for (const path of ['/ok', '/error']) {
        expect(await strict(target(path)), path).toMatchObject({
          status: 'DOWN',
          failureReason: 'blocked_address',
          statusCode: null,
        });
      }
      expect(hits).toEqual([]); // the target never saw a connection
    });

    it('refuses loopback, metadata and private literals and trailing-dot localhost', async () => {
      for (const url of [
        'http://127.0.0.1:1/',
        'http://169.254.169.254/latest/meta-data/',
        'http://10.0.0.1/',
        'http://[::1]/',
        'http://localhost./',
        'http://2130706433/',
      ]) {
        const result = await strict({ url, timeoutMs: 500, expectedStatus: 200 });
        expect(result.failureReason, url).toBe('blocked_address');
      }
    });
  });
});

describe('classifyError', () => {
  const err = (code: string, name = 'Error', message = '') =>
    Object.assign(new Error(message), { code, name });

  it.each([
    [err('ECONNREFUSED'), 'connection_refused'],
    [err('ECONNRESET'), 'connection_reset'],
    [err('EPIPE'), 'connection_reset'],
    [err('ENOTFOUND'), 'dns_failure'],
    [err('EAI_AGAIN'), 'dns_failure'],
    [err('ETIMEDOUT'), 'timeout'],
    [err('ABORT_ERR', 'AbortError'), 'timeout'],
    [err('', 'TimeoutError'), 'timeout'],
    [err('CERT_HAS_EXPIRED'), 'tls_error'],
    [err('DEPTH_ZERO_SELF_SIGNED_CERT'), 'tls_error'],
    [err('UNABLE_TO_VERIFY_LEAF_SIGNATURE'), 'tls_error'],
    [err('ERR_TLS_CERT_ALTNAME_INVALID'), 'tls_error'],
    [err('BLOCKED_ADDRESS', 'BlockedAddressError'), 'blocked_address'],
    [err('SOMETHING_ELSE'), 'request_error'],
  ] as const)('%s → %s', (error, reason) => {
    expect(classifyError(error)).toBe(reason);
  });

  it('looks inside AggregateError (dual-stack connection attempts)', () => {
    expect(classifyError(new AggregateError([err('ECONNREFUSED'), err('ECONNREFUSED')]))).toBe(
      'connection_refused',
    );
  });

  it('classifies unknown values safely', () => {
    expect(classifyError(undefined)).toBe('request_error');
    expect(classifyError('string')).toBe('request_error');
    expect(classifyError(null)).toBe('request_error');
  });
});
