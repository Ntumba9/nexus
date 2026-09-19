import { Inject, Injectable } from '@nestjs/common';
import type { Prisma, PrismaClient } from '@nexus/database';
import { recomputeServiceHealth } from '@nexus/database';
import type { ApiEnv } from '@nexus/config';
import {
  CHECK_LIMITS,
  type CreateCheckInput,
  type FailureReason,
  type ListResultsQuery,
  type MonitoringCheckDto,
  type MonitoringResultPageDto,
  type UpdateCheckInput,
} from '@nexus/shared';
import { validateMonitoringUrl } from '@nexus/shared/net-safety';
import { ApiError } from '../common/api-error';
import type { TenantContext } from '../common/request-context';
import { ENV, PRISMA } from '../infrastructure/tokens';

const checkSelect = {
  id: true,
  serviceId: true,
  name: true,
  type: true,
  url: true,
  expectedStatus: true,
  timeoutMs: true,
  intervalSeconds: true,
  failureThreshold: true,
  recoveryThreshold: true,
  incidentSeverity: true,
  createIncidents: true,
  enabled: true,
  healthStatus: true,
  consecutiveFailures: true,
  lastCheckedAt: true,
  nextRunAt: true,
  createdAt: true,
} satisfies Prisma.MonitoringCheckSelect;

type CheckRow = Prisma.MonitoringCheckGetPayload<{ select: typeof checkSelect }>;

function toDto(row: CheckRow): MonitoringCheckDto {
  return {
    ...row,
    type: 'HTTP',
    healthStatus: row.healthStatus as MonitoringCheckDto['healthStatus'],
    lastCheckedAt: row.lastCheckedAt?.toISOString() ?? null,
    nextRunAt: row.nextRunAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

@Injectable()
export class MonitoringService {
  private readonly allowPrivate: boolean;

  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(ENV) env: ApiEnv,
  ) {
    this.allowPrivate = env.MONITORING_ALLOW_PRIVATE_NETWORKS;
  }

  async list(tenant: TenantContext, serviceId: string): Promise<MonitoringCheckDto[]> {
    await this.requireService(this.prisma, tenant, serviceId);
    const rows = await this.prisma.monitoringCheck.findMany({
      where: { organizationId: tenant.organizationId, serviceId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: checkSelect,
    });
    return rows.map(toDto);
  }

  async get(tenant: TenantContext, checkId: string): Promise<MonitoringCheckDto> {
    const row = await this.prisma.monitoringCheck.findFirst({
      where: { id: checkId, organizationId: tenant.organizationId },
      select: checkSelect,
    });
    if (!row) throw ApiError.notFound('Check not found');
    return toDto(row);
  }

  async create(
    tenant: TenantContext,
    serviceId: string,
    input: CreateCheckInput,
  ): Promise<MonitoringCheckDto> {
    const url = this.validatedUrl(input.url);
    return this.prisma.$transaction(async (tx) => {
      const service = await this.requireService(tx, tenant, serviceId);
      if (service.archivedAt) {
        throw ApiError.conflict('SERVICE_ARCHIVED', 'Cannot add checks to an archived service');
      }
      const existing = await tx.monitoringCheck.count({
        where: { organizationId: tenant.organizationId, serviceId },
      });
      if (existing >= CHECK_LIMITS.maxChecksPerService) {
        throw ApiError.conflict(
          'CHECK_LIMIT',
          `A service can have at most ${CHECK_LIMITS.maxChecksPerService} checks`,
        );
      }
      const row = await tx.monitoringCheck.create({
        data: { ...input, url, organizationId: tenant.organizationId, serviceId },
        select: checkSelect,
      });
      return toDto(row);
    });
  }

  async update(
    tenant: TenantContext,
    checkId: string,
    input: UpdateCheckInput,
  ): Promise<MonitoringCheckDto> {
    const url = input.url === undefined ? undefined : this.validatedUrl(input.url);
    return this.prisma.$transaction(async (tx) => {
      // Serialise with the monitoring worker, which updates the same row's state.
      const current = await this.lockCheck(tx, tenant, checkId);

      const data: Prisma.MonitoringCheckUncheckedUpdateManyInput = { ...input };
      if (url !== undefined) data.url = url;

      const targetChanged =
        (url !== undefined && url !== current.url) ||
        (input.expectedStatus !== undefined && input.expectedStatus !== current.expectedStatus);
      if (targetChanged) {
        // The old verdict was about a different target; start again.
        Object.assign(data, {
          healthStatus: 'UNKNOWN',
          consecutiveFailures: 0,
          consecutiveSuccesses: 0,
          nextRunAt: new Date(),
        });
      }
      if (input.enabled === true && !current.enabled) data.nextRunAt = new Date();

      await tx.monitoringCheck.updateMany({
        where: { id: checkId, organizationId: tenant.organizationId },
        data,
      });
      if (targetChanged || input.enabled !== undefined) {
        await recomputeServiceHealth(tx, tenant.organizationId, current.serviceId);
      }
      const row = await tx.monitoringCheck.findFirstOrThrow({
        where: { id: checkId, organizationId: tenant.organizationId },
        select: checkSelect,
      });
      return toDto(row);
    });
  }

  async remove(tenant: TenantContext, checkId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const current = await this.lockCheck(tx, tenant, checkId);
      await tx.monitoringCheck.deleteMany({
        where: { id: checkId, organizationId: tenant.organizationId },
      });
      await recomputeServiceHealth(tx, tenant.organizationId, current.serviceId);
    });
  }

  /** Ask the dispatcher to run this check as soon as possible (it picks it up on its next tick). */
  async runNow(tenant: TenantContext, checkId: string): Promise<void> {
    const found = await this.prisma.monitoringCheck.findFirst({
      where: { id: checkId, organizationId: tenant.organizationId },
      select: { enabled: true },
    });
    if (!found) throw ApiError.notFound('Check not found');
    if (!found.enabled)
      throw ApiError.conflict('CHECK_DISABLED', 'Enable the check before running it');
    await this.prisma.monitoringCheck.updateMany({
      where: { id: checkId, organizationId: tenant.organizationId, enabled: true },
      data: { nextRunAt: new Date() },
    });
  }

  async results(
    tenant: TenantContext,
    checkId: string,
    query: ListResultsQuery,
  ): Promise<MonitoringResultPageDto> {
    const check = await this.prisma.monitoringCheck.findFirst({
      where: { id: checkId, organizationId: tenant.organizationId },
      select: { id: true },
    });
    if (!check) throw ApiError.notFound('Check not found');

    const rows = await this.prisma.monitoringResult.findMany({
      where: {
        checkId,
        organizationId: tenant.organizationId,
        ...(query.before ? { checkedAt: { lt: new Date(query.before) } } : {}),
      },
      orderBy: [{ checkedAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
      select: {
        id: true,
        status: true,
        statusCode: true,
        responseTimeMs: true,
        failureReason: true,
        checkedAt: true,
      },
    });
    const page = rows.slice(0, query.limit);
    return {
      data: page.map((row) => ({
        id: row.id,
        status: row.status,
        statusCode: row.statusCode,
        responseTimeMs: row.responseTimeMs,
        failureReason: row.failureReason as FailureReason | null,
        checkedAt: row.checkedAt.toISOString(),
      })),
      nextBefore: rows.length > query.limit ? page[page.length - 1]!.checkedAt.toISOString() : null,
    };
  }

  // ---- Helpers ----------------------------------------------------------------------------

  private validatedUrl(raw: string): string {
    const result = validateMonitoringUrl(raw, { allowPrivate: this.allowPrivate });
    if (!result.ok) {
      throw new ApiError(400, 'URL_NOT_ALLOWED', result.reason, [
        { path: 'url', message: result.reason },
      ]);
    }
    return result.url.href;
  }

  private async requireService(
    db: Pick<PrismaClient, 'service'> | Prisma.TransactionClient,
    tenant: TenantContext,
    serviceId: string,
  ) {
    const service = await db.service.findFirst({
      where: { id: serviceId, organizationId: tenant.organizationId },
      select: { id: true, archivedAt: true },
    });
    if (!service) throw ApiError.notFound('Service not found');
    return service;
  }

  /** Lock the check row for the rest of the transaction and return the fields we compare against. */
  private async lockCheck(tx: Prisma.TransactionClient, tenant: TenantContext, checkId: string) {
    await tx.$queryRaw`SELECT "id" FROM "MonitoringCheck" WHERE "id" = ${checkId}::uuid AND "organizationId" = ${tenant.organizationId}::uuid FOR UPDATE`;
    const current = await tx.monitoringCheck.findFirst({
      where: { id: checkId, organizationId: tenant.organizationId },
      select: { serviceId: true, url: true, expectedStatus: true, enabled: true },
    });
    if (!current) throw ApiError.notFound('Check not found');
    return current;
  }
}
