import http from 'node:http';
import https from 'node:https';
import type { CheckOutcome, FailureReason } from '@nexus/shared';
import { createSafeLookup, validateMonitoringUrl } from '@nexus/shared/net-safety';

export interface CheckTarget {
  url: string;
  timeoutMs: number;
  expectedStatus: number;
}

export interface CheckResult {
  status: CheckOutcome;
  statusCode: number | null;
  responseTimeMs: number | null;
  failureReason: FailureReason | null;
}

export type Checker = (target: CheckTarget) => Promise<CheckResult>;

const USER_AGENT = 'NEXUS-Monitor/1.0';

const down = (
  failureReason: FailureReason,
  extra: Partial<Pick<CheckResult, 'statusCode' | 'responseTimeMs'>> = {},
): CheckResult => ({
  status: 'DOWN',
  statusCode: extra.statusCode ?? null,
  responseTimeMs: extra.responseTimeMs ?? null,
  failureReason,
});

/** Map a low-level network error onto the closed set of reasons we store and show. */
export function classifyError(error: unknown): FailureReason {
  const candidates: unknown[] = [error];
  if (error instanceof AggregateError) candidates.push(...error.errors);

  for (const candidate of candidates) {
    const err = candidate as { code?: string; name?: string; message?: string };
    const code = err?.code ?? '';
    if (code === 'BLOCKED_ADDRESS' || err?.name === 'BlockedAddressError') return 'blocked_address';
    if (code === 'ABORT_ERR' || err?.name === 'AbortError' || err?.name === 'TimeoutError')
      return 'timeout';
    if (code === 'ETIMEDOUT') return 'timeout';
    if (['ENOTFOUND', 'EAI_AGAIN', 'EAI_FAIL', 'ENODATA'].includes(code)) return 'dns_failure';
    if (code === 'ECONNREFUSED') return 'connection_refused';
    if (['ECONNRESET', 'EPIPE', 'ECONNABORTED', 'UND_ERR_SOCKET'].includes(code))
      return 'connection_reset';
    if (
      code.startsWith('ERR_TLS') ||
      code.startsWith('ERR_SSL') ||
      /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|HOSTNAME_MISMATCH/.test(code) ||
      /certificate|tls|ssl/i.test(err?.message ?? '')
    ) {
      return 'tls_error';
    }
  }
  return 'request_error';
}

/**
 * Performs one HTTP(S) check. Security properties (see docs/security.md, SSRF):
 *  - the URL is re-validated here, not only when it was saved;
 *  - the hostname is resolved by our own `lookup`, which refuses if ANY address is non-public and
 *    gives the socket only validated addresses, so DNS rebinding cannot redirect the connection;
 *  - redirects are never followed (a 3xx is simply "unexpected status"), so a public URL cannot bounce
 *    us to an internal one;
 *  - the response body is never read: the socket is destroyed as soon as headers arrive;
 *  - the whole attempt, including DNS and TLS, has a hard deadline.
 * Never throws: every outcome, including failures, is a returned result.
 */
export function createHttpChecker(options: { allowPrivate: boolean }): Checker {
  const lookup = createSafeLookup(options);

  return (target) =>
    new Promise<CheckResult>((resolve) => {
      const structural = validateMonitoringUrl(target.url, { allowPrivate: true });
      if (!structural.ok) return resolve(down('invalid_url'));
      if (!validateMonitoringUrl(target.url, options).ok) return resolve(down('blocked_address'));

      const url = structural.url;
      const client = url.protocol === 'https:' ? https : http;
      const started = performance.now();
      let settled = false;
      const finish = (result: CheckResult) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };

      try {
        const request = client.request(
          url,
          {
            method: 'GET',
            lookup,
            agent: false, // a fresh connection every time: we are measuring, not optimising
            signal: AbortSignal.timeout(target.timeoutMs),
            headers: { 'user-agent': USER_AGENT, accept: '*/*', connection: 'close' },
          },
          (response) => {
            const responseTimeMs = Math.round(performance.now() - started);
            const statusCode = response.statusCode ?? 0;
            response.destroy(); // never download the body
            finish(
              statusCode === target.expectedStatus
                ? { status: 'UP', statusCode, responseTimeMs, failureReason: null }
                : down('unexpected_status', { statusCode, responseTimeMs }),
            );
          },
        );
        request.on('error', (error) => finish(down(classifyError(error))));
        request.end();
      } catch (error) {
        finish(down(classifyError(error)));
      }
    });
}
