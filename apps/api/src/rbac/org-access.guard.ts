import { CanActivate, ExecutionContext, Inject, Injectable, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { PrismaClient } from '@nexus/database';
import { roleHasPermission, type Permission } from '@nexus/shared';
import { ApiError } from '../common/api-error';
import type { AppRequest } from '../common/request-context';
import { uuidSchema } from '../common/zod.pipe';
import { noteRequestScope } from '../common/request-store';
import { PRISMA } from '../infrastructure/tokens';
import { AUTHENTICATED_ONLY_KEY, IS_PUBLIC_KEY, PERMISSION_KEY } from './decorators';

/**
 * Global guard, runs after SessionGuard. For any route containing `:orgId` it:
 *  1. looks up the caller's membership for THAT organisation (from the database, never from the
 *     client) and returns 404 if there is none, so other tenants' organisations are indistinguishable
 *     from nonexistent ones;
 *  2. requires the route to declare a permission (default-deny for undeclared routes);
 *  3. checks the member's role grants that permission (403 otherwise);
 *  4. exposes the verified tenant context to handlers as `request.tenant`.
 */
@Injectable()
export class OrgAccessGuard implements CanActivate {
  private readonly logger = new Logger(OrgAccessGuard.name);

  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(PRISMA) private readonly prisma: PrismaClient,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets)) return true;

    const request = context.switchToHttp().getRequest<AppRequest>();
    const rawOrgId: unknown = request.params?.orgId;
    const permission = this.reflector.getAllAndOverride<Permission | undefined>(
      PERMISSION_KEY,
      targets,
    );

    if (rawOrgId === undefined) {
      const authenticatedOnly = this.reflector.getAllAndOverride<boolean>(
        AUTHENTICATED_ONLY_KEY,
        targets,
      );
      if (!authenticatedOnly && !permission) {
        this.logger.error(
          `Route ${request.method} ${request.path} declares no access rule; denying`,
        );
        throw ApiError.forbidden('ROUTE_MISCONFIGURED', 'Access denied');
      }
      return true;
    }

    const auth = request.auth;
    if (!auth) throw ApiError.unauthenticated();

    const parsed = uuidSchema.safeParse(rawOrgId);
    if (!parsed.success) throw ApiError.notFound('Organization not found');

    const membership = await this.prisma.organizationMember.findUnique({
      where: { organizationId_userId: { organizationId: parsed.data, userId: auth.user.id } },
      select: { id: true, role: true },
    });
    if (!membership) throw ApiError.notFound('Organization not found');

    if (!permission) {
      this.logger.error(
        `Route ${request.method} ${request.path} is org-scoped but declares no permission; denying`,
      );
      throw ApiError.forbidden('ROUTE_MISCONFIGURED', 'Access denied');
    }
    if (!roleHasPermission(membership.role, permission)) throw ApiError.forbidden();

    noteRequestScope({ organizationId: parsed.data });
    request.tenant = {
      organizationId: parsed.data,
      userId: auth.user.id,
      memberId: membership.id,
      role: membership.role,
    };
    return true;
  }
}
