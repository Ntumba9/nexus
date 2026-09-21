import { createServer, type Server } from 'node:http';
import { bearerMatches } from '@nexus/shared';
import type { Logger } from './logger';

/** A named dependency probe: resolves if healthy, rejects otherwise. */
export type ReadinessProbe = { name: string; check: () => Promise<unknown> };

/**
 * Tiny HTTP server exposing liveness/readiness for container orchestrators (workers otherwise
 * have no port). Readiness requires every dependency (Redis and PostgreSQL), since a worker missing
 * either cannot do its work.
 */
export function startHealthServer(
  options: {
    host: string;
    port: number;
    probes: ReadinessProbe[];
    /** `GET /metrics`: only exists when a token is configured, and then needs it as a bearer token. */
    metrics?: { token: string; render: () => Promise<string> };
  },
  logger: Logger,
): Server {
  const server = createServer((req, res) => {
    const send = (status: number, body: object) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    if (req.method !== 'GET') return send(405, { status: 'error' });
    if (req.url === '/health/live') return send(200, { status: 'ok' });
    if (req.url === '/metrics') {
      const metrics = options.metrics;
      if (!metrics) return send(404, { status: 'not_found' });
      if (!bearerMatches(req.headers.authorization, metrics.token)) {
        return send(401, { status: 'unauthorized' });
      }
      void metrics.render().then(
        (text) => {
          res.writeHead(200, {
            'content-type': 'text/plain; version=0.0.4; charset=utf-8',
            'cache-control': 'no-store',
          });
          res.end(text);
        },
        () => send(500, { status: 'error' }),
      );
      return;
    }
    if (req.url === '/health/ready') {
      void Promise.all(
        options.probes.map(async (probe) => {
          try {
            await probe.check();
            return [probe.name, { status: 'up' }] as const;
          } catch (error) {
            logger.warn('readiness check failed', {
              probe: probe.name,
              error: error instanceof Error ? error.message : String(error),
            });
            return [probe.name, { status: 'down' }] as const;
          }
        }),
      ).then((entries) => {
        const allUp = entries.every(([, check]) => check.status === 'up');
        send(allUp ? 200 : 503, {
          status: allUp ? 'ok' : 'down',
          checks: Object.fromEntries(entries),
        });
      });
      return;
    }
    send(404, { status: 'not_found' });
  });
  server.listen(options.port, options.host, () =>
    logger.info('worker health server listening', { host: options.host, port: options.port }),
  );
  return server;
}
