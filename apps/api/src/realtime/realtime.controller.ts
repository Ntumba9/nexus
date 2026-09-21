import { Controller, Get, Inject, Logger, Req, Res } from '@nestjs/common';
import type { ApiEnv } from '@nexus/config';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { PrismaClient } from '@nexus/database';
import {
  roleHasPermission,
  TOPIC_PERMISSION,
  type RealtimeMessage,
  type Role,
} from '@nexus/shared';
import type { Response } from 'express';
import { ApiError } from '../common/api-error';
import type { AppRequest } from '../common/request-context';
import { ENV, PRISMA } from '../infrastructure/tokens';
import { RequirePermission } from '../rbac/decorators';
import { RealtimeHub } from './realtime.hub';

/** Open streams per user on one API instance. A tab holds one; this stops a runaway client. */
export const MAX_STREAMS_PER_USER = 10;

@ApiTags('realtime')
@Controller('orgs/:orgId/events')
export class RealtimeController {
  private readonly logger = new Logger(RealtimeController.name);
  private readonly openByUser = new Map<string, number>();

  constructor(
    @Inject(RealtimeHub) private readonly hub: RealtimeHub,
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(ENV) private readonly env: ApiEnv,
  ) {}

  /**
   * A Server-Sent Events stream of change signals for one organisation (ADR-014). Messages carry a
   * topic and no data: the browser refetches through the REST API, so authorization stays there.
   * The caller was already authenticated and confirmed as a member by the global guards; the stream
   * additionally re-checks membership, role and session on every heartbeat and ends when any of
   * them stops holding.
   */
  @Get()
  @RequirePermission('organization.read')
  @ApiOperation({ summary: 'Stream real-time change signals (Server-Sent Events)' })
  stream(@Req() request: AppRequest, @Res() response: Response): void {
    const tenant = request.tenant;
    const auth = request.auth;
    if (!tenant || !auth) throw ApiError.forbidden('ROUTE_MISCONFIGURED', 'Access denied');

    const open = this.openByUser.get(tenant.userId) ?? 0;
    if (open >= MAX_STREAMS_PER_USER) {
      throw new ApiError(429, 'TOO_MANY_STREAMS', 'Too many open real-time connections');
    }
    this.openByUser.set(tenant.userId, open + 1);

    let role: Role = tenant.role;
    let closed = false;

    response.status(200).set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Tell reverse proxies (nginx) not to buffer the stream.
      'X-Accel-Buffering': 'no',
    });
    response.flushHeaders();
    response.write('retry: 3000\n\n');
    // `ready` tells the browser it is (re)connected, so it refetches whatever it missed.
    response.write('event: ready\ndata: {}\n\n');

    const send = (message: RealtimeMessage): void => {
      if (closed) return;
      if (message.userId !== undefined && message.userId !== tenant.userId) return;
      if (!roleHasPermission(role, TOPIC_PERMISSION[message.topic])) return;
      response.write(`event: change\ndata: ${JSON.stringify({ topic: message.topic })}\n\n`);
    };

    const unsubscribe = this.hub.subscribe(tenant.organizationId, send);

    const close = (): void => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
      const remaining = (this.openByUser.get(tenant.userId) ?? 1) - 1;
      if (remaining <= 0) this.openByUser.delete(tenant.userId);
      else this.openByUser.set(tenant.userId, remaining);
      if (!response.writableEnded) response.end();
    };

    const heartbeat = setInterval(() => {
      if (closed) return;
      // A comment line keeps proxies from closing an idle connection.
      response.write(': keep-alive\n\n');
      void this.stillAllowed(tenant.organizationId, tenant.userId, auth.sessionId).then(
        (current) => {
          if (current === null) close();
          else role = current;
        },
        (error: unknown) =>
          this.logger.warn(
            `Stream re-check failed: ${error instanceof Error ? error.message : String(error)}`,
          ),
      );
    }, this.env.REALTIME_HEARTBEAT_MS);
    heartbeat.unref();

    request.on('close', close);
    response.on('error', close);
  }

  /** The member's current role, or null if they may no longer hold this stream open. */
  private async stillAllowed(
    organizationId: string,
    userId: string,
    sessionId: string,
  ): Promise<Role | null> {
    const [member, session] = await Promise.all([
      this.prisma.organizationMember.findUnique({
        where: { organizationId_userId: { organizationId, userId } },
        select: { role: true, user: { select: { disabledAt: true } } },
      }),
      this.prisma.session.findUnique({
        where: { id: sessionId },
        select: { revokedAt: true, absoluteExpiresAt: true },
      }),
    ]);
    if (!member || member.user.disabledAt) return null;
    if (!session || session.revokedAt || session.absoluteExpiresAt <= new Date()) return null;
    return member.role;
  }
}
