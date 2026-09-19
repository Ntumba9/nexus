import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { ApiEnv } from '@nexus/config';
import type { NextFunction, Response } from 'express';
import helmet from 'helmet';
import { AllExceptionsFilter } from './common/all-exceptions.filter';
import { ApiError } from './common/api-error';
import type { AppRequest } from './common/request-context';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Machine-to-machine endpoints authenticated by a request signature instead of a session cookie.
 * They are not browser-driven, so they carry no Origin header and are exempt from the CSRF check.
 */
const SIGNED_WEBHOOK_PREFIX = '/api/v1/webhooks/';

/** Attach a correlation id to every request and echo it back to the client. */
function requestId(request: AppRequest, response: Response, next: NextFunction): void {
  request.id = randomUUID();
  response.setHeader('X-Request-Id', request.id);
  next();
}

/**
 * CSRF defence for cookie-authenticated requests, complementing SameSite=Lax cookies: any
 * state-changing request must carry an `Origin` header naming the web app. Browsers always send
 * Origin on cross-site POST/PUT/PATCH/DELETE, so a forged cross-site request is rejected.
 */
function originCheck(allowedOrigin: string) {
  const allowed = new URL(allowedOrigin).origin;
  return (request: AppRequest, response: Response, next: NextFunction): void => {
    if (SAFE_METHODS.has(request.method)) return next();
    if (request.path.startsWith(SIGNED_WEBHOOK_PREFIX)) return next();
    if (request.headers.origin !== allowed) {
      // Raw Express middleware sits outside Nest's exception filters, so reply directly.
      const error = ApiError.forbidden('CSRF_ORIGIN_MISMATCH', 'Request origin is not allowed');
      response
        .status(error.getStatus())
        .json({ error: { code: error.code, message: error.message, requestId: request.id } });
      return;
    }
    next();
  };
}

/**
 * Shared bootstrap for the real server and for integration tests, so tests exercise exactly the
 * middleware, prefix and error handling that production uses.
 */
export function configureApp(app: NestExpressApplication, env: ApiEnv): void {
  app.set('trust proxy', env.TRUST_PROXY_HOPS);
  app.disable('x-powered-by');

  const secureHeaders = helmet();
  app.use(requestId);
  // Swagger UI needs inline scripts that helmet's default CSP blocks; it is a dev-only page.
  app.use((request: AppRequest, response: Response, next: NextFunction) =>
    request.path.startsWith('/api/docs') ? next() : secureHeaders(request, response, next),
  );
  app.use(originCheck(env.WEB_ORIGIN));
  app.enableCors({ origin: env.WEB_ORIGIN, credentials: true });

  app.setGlobalPrefix('api/v1', { exclude: ['health/live', 'health/ready'] });
  app.useGlobalFilters(new AllExceptionsFilter());
}
