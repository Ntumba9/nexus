import { Inject, Injectable } from '@nestjs/common';
import type { PrismaClient } from '@nexus/database';
import type {
  AutomationTrigger,
  ListNotificationsQuery,
  NotificationDto,
  NotificationPageDto,
} from '@nexus/shared';
import { ApiError } from '../common/api-error';
import type { TenantContext } from '../common/request-context';
import { PRISMA } from '../infrastructure/tokens';

/**
 * A person's own inbox. Every query is scoped by the organization AND by the signed-in user taken
 * from the verified session, never from a parameter, so there is no way to ask for someone else's
 * notifications: another user's id simply does not appear anywhere in a request.
 */
@Injectable()
export class NotificationsService {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  private mine(tenant: TenantContext) {
    return { organizationId: tenant.organizationId, userId: tenant.userId, inApp: true };
  }

  async list(tenant: TenantContext, query: ListNotificationsQuery): Promise<NotificationPageDto> {
    const [rows, unreadCount] = await Promise.all([
      this.prisma.notification.findMany({
        where: {
          ...this.mine(tenant),
          ...(query.unread ? { readAt: null } : {}),
          ...(query.before ? { createdAt: { lt: new Date(query.before) } } : {}),
        },
        orderBy: { createdAt: 'desc' },
        take: query.limit + 1,
        select: {
          id: true,
          type: true,
          title: true,
          body: true,
          link: true,
          readAt: true,
          createdAt: true,
        },
      }),
      this.unreadCount(tenant),
    ]);
    const data: NotificationDto[] = rows.slice(0, query.limit).map((row) => ({
      id: row.id,
      type: row.type as AutomationTrigger,
      title: row.title,
      body: row.body,
      link: row.link,
      readAt: row.readAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    }));
    return {
      data,
      unreadCount,
      nextBefore: rows.length > query.limit ? (data.at(-1)?.createdAt ?? null) : null,
    };
  }

  unreadCount(tenant: TenantContext): Promise<number> {
    return this.prisma.notification.count({ where: { ...this.mine(tenant), readAt: null } });
  }

  /** Idempotent: marking an already-read notification read is fine. Someone else's is a 404. */
  async markRead(tenant: TenantContext, id: string): Promise<void> {
    const { count } = await this.prisma.notification.updateMany({
      where: { id, ...this.mine(tenant), readAt: null },
      data: { readAt: new Date() },
    });
    if (count > 0) return;
    const exists = await this.prisma.notification.findFirst({
      where: { id, ...this.mine(tenant) },
      select: { id: true },
    });
    if (!exists) throw ApiError.notFound('Notification not found');
  }

  async markAllRead(tenant: TenantContext): Promise<{ updated: number }> {
    const { count } = await this.prisma.notification.updateMany({
      where: { ...this.mine(tenant), readAt: null },
      data: { readAt: new Date() },
    });
    return { updated: count };
  }
}
