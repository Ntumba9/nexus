import { createServer, type Server } from 'node:http';
import type { Redis } from 'ioredis';
import type { Logger } from './logger';

/**
 * Tiny HTTP server exposing liveness/readiness for container orchestrators (workers otherwise
 * have no port). Readiness requires Redis, since a worker without Redis cannot do any work.
 */
export function startHealthServer(
  options: { host: string; port: number; redis: Redis },
  logger: Logger,
): Server {
  const server = createServer((req, res) => {
    const send = (status: number, body: object) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    if (req.method !== 'GET') return send(405, { status: 'error' });
    if (req.url === '/health/live') return send(200, { status: 'ok' });
    if (req.url === '/health/ready') {
      options.redis.ping().then(
        () => send(200, { status: 'ok', checks: { redis: { status: 'up' } } }),
        (error: unknown) => {
          logger.warn('readiness check failed', {
            error: error instanceof Error ? error.message : String(error),
          });
          send(503, { status: 'down', checks: { redis: { status: 'down' } } });
        },
      );
      return;
    }
    send(404, { status: 'not_found' });
  });
  server.listen(options.port, options.host, () =>
    logger.info('worker health server listening', { host: options.host, port: options.port }),
  );
  return server;
}
