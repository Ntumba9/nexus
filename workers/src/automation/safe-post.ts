import http from 'node:http';
import https from 'node:https';
import type { FailureReason } from '@nexus/shared';
import { createSafeLookup, validateMonitoringUrl } from '@nexus/shared/net-safety';
import { classifyError } from '../monitoring/http-checker';

export interface PostRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
}

export type PostResult =
  { ok: true; statusCode: number } | { ok: false; reason: FailureReason; statusCode?: number };

export type SafePoster = (request: PostRequest) => Promise<PostResult>;

/**
 * POST to a user-supplied URL with the same SSRF protections as monitoring (see docs/security.md):
 *  - the URL is validated again here, not only when it was saved;
 *  - the hostname is resolved by our own `lookup`, which refuses if ANY address is non-public and
 *    hands the socket only validated addresses, so DNS rebinding cannot redirect the connection;
 *  - redirects are never followed, so a public URL cannot bounce us to an internal one;
 *  - the response body is never read;
 *  - the whole attempt, DNS and TLS included, has a hard deadline.
 * Never throws: every outcome is a returned result.
 */
export function createSafePoster(options: { allowPrivate: boolean }): SafePoster {
  const lookup = createSafeLookup(options);

  return (request) =>
    new Promise<PostResult>((resolve) => {
      const structural = validateMonitoringUrl(request.url, { allowPrivate: true });
      if (!structural.ok) return resolve({ ok: false, reason: 'invalid_url' });
      if (!validateMonitoringUrl(request.url, options).ok) {
        return resolve({ ok: false, reason: 'blocked_address' });
      }

      const url = structural.url;
      const client = url.protocol === 'https:' ? https : http;
      let settled = false;
      const finish = (result: PostResult) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };

      try {
        const req = client.request(
          url,
          {
            method: 'POST',
            lookup,
            agent: false,
            signal: AbortSignal.timeout(request.timeoutMs),
            headers: {
              ...request.headers,
              'content-length': String(Buffer.byteLength(request.body)),
              connection: 'close',
            },
          },
          (response) => {
            const statusCode = response.statusCode ?? 0;
            response.destroy(); // never download the body
            finish(
              statusCode >= 200 && statusCode < 300
                ? { ok: true, statusCode }
                : { ok: false, reason: 'unexpected_status', statusCode },
            );
          },
        );
        req.on('error', (error) => finish({ ok: false, reason: classifyError(error) }));
        req.end(request.body);
      } catch (error) {
        finish({ ok: false, reason: classifyError(error) });
      }
    });
}
