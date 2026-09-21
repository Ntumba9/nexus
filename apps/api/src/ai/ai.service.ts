import { Inject, Injectable, Logger } from '@nestjs/common';
import type { AnalysisProvider, Prisma, PrismaClient } from '@nexus/database';
import {
  AI_JOBS,
  AI_LIMITS,
  investigationOutputSchema,
  type AiStatusDto,
  type ContextSource,
  type InvestigationDto,
  type InvestigationJobPayload,
  type StartInvestigationInput,
} from '@nexus/shared';
import type { Queue } from 'bullmq';
import { AuditService } from '../audit/audit.service';
import { ApiError } from '../common/api-error';
import type { TenantContext } from '../common/request-context';
import { AI_QUEUE, PRISMA } from '../infrastructure/tokens';
import type { RateLimiter } from '../rate-limit/rate-limiter';
import { RATE_LIMITER } from '../rate-limit/tokens';
import { ANALYSIS } from './tokens';

const UNIQUE_VIOLATION = 'P2002';

const investigationSelect = {
  id: true,
  incidentId: true,
  status: true,
  question: true,
  providerLabel: true,
  context: true,
  output: true,
  droppedCitations: true,
  droppedClaims: true,
  downgradedCauses: true,
  truncated: true,
  error: true,
  createdAt: true,
  finishedAt: true,
  requestedBy: { select: { name: true } },
} satisfies Prisma.AiInvestigationSelect;

type Row = Prisma.AiInvestigationGetPayload<{ select: typeof investigationSelect }>;

/** Stored JSON is only ever trusted after it is parsed again on the way out. */
function toDto(row: Row): InvestigationDto {
  const output = investigationOutputSchema.safeParse(row.output);
  return {
    id: row.id,
    incidentId: row.incidentId,
    status: row.status,
    question: row.question,
    providerLabel: row.providerLabel,
    requestedByName: row.requestedBy?.name ?? null,
    createdAt: row.createdAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
    output: output.success ? output.data : null,
    sources: Array.isArray(row.context) ? (row.context as unknown as ContextSource[]) : [],
    droppedCitations: row.droppedCitations,
    droppedClaims: row.droppedClaims,
    downgradedCauses: row.downgradedCauses,
    truncated: row.truncated,
    error: row.error,
  };
}

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);

  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(AI_QUEUE) private readonly queue: Queue,
    @Inject(ANALYSIS) private readonly provider: AnalysisProvider | null,
    @Inject(RATE_LIMITER) private readonly limiter: RateLimiter,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  status(): AiStatusDto {
    if (!this.provider) {
      return { available: false, kind: 'none', label: 'AI investigation is turned off' };
    }
    return {
      available: true,
      kind: this.provider.kind === 'model' ? 'model' : 'rules',
      label: this.provider.label,
    };
  }

  private async requireIncident(tenant: TenantContext, incidentId: string) {
    const incident = await this.prisma.incident.findFirst({
      where: { id: incidentId, organizationId: tenant.organizationId },
      select: { id: true, number: true },
    });
    if (!incident) throw ApiError.notFound('Incident not found');
    return incident;
  }

  async list(tenant: TenantContext, incidentId: string): Promise<InvestigationDto[]> {
    await this.requireIncident(tenant, incidentId);
    const rows = await this.prisma.aiInvestigation.findMany({
      where: { organizationId: tenant.organizationId, incidentId },
      orderBy: { createdAt: 'desc' },
      take: AI_LIMITS.historyLimit,
      select: investigationSelect,
    });
    return rows.map(toDto);
  }

  async start(
    tenant: TenantContext,
    requestId: string | undefined,
    incidentId: string,
    input: StartInvestigationInput,
  ): Promise<InvestigationDto> {
    const provider = this.provider;
    if (!provider) {
      throw ApiError.conflict('AI_DISABLED', 'AI investigation is turned off on this server');
    }
    const incident = await this.requireIncident(tenant, incidentId);
    // Each run can cost a model call, so it is limited per person. If the limiter is down this fails
    // closed (503): better no run than an unmetered one.
    await this.limiter.consume('ai-investigation', tenant.userId, AI_LIMITS.perUserPerHour, 3600);

    let id: string;
    try {
      id = await this.prisma.$transaction(async (tx) => {
        // A run that never finished (a worker died) must not block the incident forever.
        await tx.aiInvestigation.updateMany({
          where: {
            organizationId: tenant.organizationId,
            incidentId,
            status: { in: ['QUEUED', 'RUNNING'] },
            createdAt: { lt: new Date(Date.now() - AI_LIMITS.staleAfterMinutes * 60_000) },
          },
          data: {
            status: 'FAILED',
            error: 'timed out before it finished',
            finishedAt: new Date(),
          },
        });
        const created = await tx.aiInvestigation.create({
          data: {
            organizationId: tenant.organizationId,
            incidentId,
            requestedById: tenant.userId,
            question: input.question ? input.question : null,
            providerId: provider.id,
            providerLabel: provider.label,
          },
          select: { id: true },
        });
        await this.audit.record(tx, tenant, requestId, {
          action: 'ai.investigation.requested',
          resourceType: 'incident',
          resourceId: incidentId,
          metadata: {
            incidentNumber: incident.number,
            provider: provider.label,
            investigationId: created.id,
            hasQuestion: Boolean(input.question),
          },
        });
        return created.id;
      });
    } catch (error) {
      // The partial unique index allows one queued or running investigation per incident.
      if ((error as { code?: string }).code === UNIQUE_VIOLATION) {
        throw ApiError.conflict(
          'INVESTIGATION_ACTIVE',
          'An investigation is already running for this incident',
        );
      }
      throw error;
    }

    const payload: InvestigationJobPayload = {
      organizationId: tenant.organizationId,
      investigationId: id,
      ...(requestId ? { requestId } : {}),
    };
    try {
      await this.queue.add(AI_JOBS.investigate, payload, {
        jobId: `ai-${id}`,
        attempts: 3,
        backoff: { type: 'exponential', delay: 3000 },
        removeOnComplete: 500,
        removeOnFail: 2000,
      });
    } catch (error) {
      this.logger.warn(
        `Could not queue an investigation: ${error instanceof Error ? error.message : String(error)}`,
      );
      await this.prisma.aiInvestigation.updateMany({
        where: { id, organizationId: tenant.organizationId, status: 'QUEUED' },
        data: { status: 'FAILED', error: 'could not be queued', finishedAt: new Date() },
      });
      throw ApiError.unavailable('QUEUE_UNAVAILABLE', 'The investigation could not be started');
    }

    const row = await this.prisma.aiInvestigation.findFirstOrThrow({
      where: { id, organizationId: tenant.organizationId },
      select: investigationSelect,
    });
    return toDto(row);
  }
}
