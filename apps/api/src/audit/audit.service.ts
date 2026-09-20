import { Inject, Injectable } from '@nestjs/common';
import { writeAuditLog } from '@nexus/database';
import type { Prisma, PrismaClient } from '@nexus/database';
import type { AuditAction, AuditLogDto, AuditLogPageDto, ListAuditLogsQuery } from '@nexus/shared';
import type { TenantContext } from '../common/request-context';
import { currentRequestId } from '../common/request-store';
import { PRISMA } from '../infrastructure/tokens';

export interface AuditRecord {
  action: AuditAction;
  resourceType: string;
  resourceId?: string | null;
  metadata?: Record<string, unknown>;
}

@Injectable()
export class AuditService {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  /**
   * Record something a signed-in person did. Call it INSIDE the transaction that makes the change,
   * so a change that rolls back leaves no entry and a change that commits always has one.
   */
  async record(
    tx: Prisma.TransactionClient,
    tenant: TenantContext,
    requestId: string | undefined,
    entry: AuditRecord,
  ): Promise<void> {
    const user = await tx.user.findUnique({ where: { id: tenant.userId }, select: { name: true } });
    await writeAuditLog(tx, {
      organizationId: tenant.organizationId,
      actor: { type: 'USER', id: tenant.userId, label: user?.name ?? 'Unknown user' },
      requestId: requestId ?? currentRequestId() ?? null,
      ...entry,
    });
  }

  async list(tenant: TenantContext, query: ListAuditLogsQuery): Promise<AuditLogPageDto> {
    const rows = await this.prisma.auditLog.findMany({
      where: {
        organizationId: tenant.organizationId,
        ...(query.action ? { action: query.action } : {}),
        ...(query.before ? { createdAt: { lt: new Date(query.before) } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: query.limit + 1,
      select: {
        id: true,
        action: true,
        actorType: true,
        actorLabel: true,
        resourceType: true,
        resourceId: true,
        metadata: true,
        createdAt: true,
      },
    });
    const page = rows.slice(0, query.limit);
    const data: AuditLogDto[] = page.map((row) => ({
      id: row.id,
      action: row.action,
      actorType: row.actorType as AuditLogDto['actorType'],
      actorLabel: row.actorLabel,
      resourceType: row.resourceType,
      resourceId: row.resourceId,
      metadata: row.metadata as Record<string, unknown>,
      createdAt: row.createdAt.toISOString(),
    }));
    return {
      data,
      nextBefore: rows.length > query.limit ? (data.at(-1)?.createdAt ?? null) : null,
    };
  }
}
