import { CallHandler, ExecutionContext, Inject, Injectable, NestInterceptor } from '@nestjs/common';
import { publishRealtime, topicsForMutation, type RealtimeMessage } from '@nexus/shared';
import type { Redis } from 'ioredis';
import { tap, type Observable } from 'rxjs';
import type { AppRequest } from '../common/request-context';
import { REDIS } from '../infrastructure/tokens';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const BELOW_ORG = /\/orgs\/[^/]+\/?(.*)$/;

/**
 * Tells every open browser in an organisation that something changed, right after a state-changing
 * request succeeded. Doing it here, once, means no controller can forget. Changes made by workers
 * (monitoring, automation, webhooks) publish from the worker instead.
 */
@Injectable()
export class MutationSignalInterceptor implements NestInterceptor {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const request = context.switchToHttp().getRequest<AppRequest>();
    if (SAFE_METHODS.has(request.method) || !request.tenant) return next.handle();

    return next.handle().pipe(
      tap(() => {
        const tenant = request.tenant;
        if (!tenant) return;
        const below = BELOW_ORG.exec(request.path)?.[1] ?? '';
        const messages: RealtimeMessage[] = topicsForMutation(below).map((topic) =>
          // Notification changes concern one person's inbox only.
          topic === 'notifications' ? { topic, userId: tenant.userId } : { topic },
        );
        // Fire and forget: a signal must never delay or fail the response.
        void publishRealtime(this.redis, tenant.organizationId, messages);
      }),
    );
  }
}
