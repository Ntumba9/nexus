import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { ApiEnv } from '@nexus/config';
import type { Prisma, PrismaClient } from '@nexus/database';
import type {
  CreateGitHubIntegrationInput,
  CreatedGitHubIntegrationDto,
  GitHubIntegrationDto,
} from '@nexus/shared';
import {
  encryptSecret,
  generateWebhookSecret,
  parseEncryptionKey,
} from '@nexus/shared/webhook-security';
import { AuditService } from '../audit/audit.service';
import { ApiError } from '../common/api-error';
import type { TenantContext } from '../common/request-context';
import { ENV, PRISMA } from '../infrastructure/tokens';

const select = {
  id: true,
  repoFullName: true,
  projectId: true,
  serviceId: true,
  status: true,
  lastEventAt: true,
  createdAt: true,
} satisfies Prisma.GitHubIntegrationSelect;

type Row = Prisma.GitHubIntegrationGetPayload<{ select: typeof select }>;

export const webhookPathFor = (integrationId: string): string =>
  `/api/v1/webhooks/github/${integrationId}`;

function toDto(row: Row): GitHubIntegrationDto {
  return {
    ...row,
    webhookPath: webhookPathFor(row.id),
    lastEventAt: row.lastEventAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

@Injectable()
export class GitHubIntegrationsService {
  private readonly key: Buffer | undefined;

  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(ENV) env: ApiEnv,
  ) {
    this.key = env.INTEGRATION_ENCRYPTION_KEY
      ? parseEncryptionKey(env.INTEGRATION_ENCRYPTION_KEY)
      : undefined;
  }

  async list(tenant: TenantContext): Promise<GitHubIntegrationDto[]> {
    const rows = await this.prisma.gitHubIntegration.findMany({
      where: { organizationId: tenant.organizationId, status: 'ACTIVE' },
      orderBy: { createdAt: 'desc' },
      select,
    });
    return rows.map(toDto);
  }

  /** Creates the integration and returns its webhook secret, which is never shown again. */
  async create(
    tenant: TenantContext,
    requestId: string | undefined,
    input: CreateGitHubIntegrationInput,
  ): Promise<CreatedGitHubIntegrationDto> {
    if (!this.key) {
      throw ApiError.unavailable(
        'INTEGRATIONS_NOT_CONFIGURED',
        'GitHub integrations are not enabled on this server (INTEGRATION_ENCRYPTION_KEY is not set)',
      );
    }
    const orgId = tenant.organizationId;
    const project = await this.prisma.project.findFirst({
      where: { id: input.projectId, organizationId: orgId, archivedAt: null },
      select: { id: true },
    });
    if (!project) throw ApiError.notFound('Project not found');
    if (input.serviceId) {
      const service = await this.prisma.service.findFirst({
        where: {
          id: input.serviceId,
          organizationId: orgId,
          projectId: input.projectId,
          archivedAt: null,
        },
        select: { id: true },
      });
      if (!service) throw ApiError.notFound('Service not found in that project');
    }

    // The row id is generated first because it is bound into the ciphertext as authenticated data.
    const id = randomUUID();
    const secret = generateWebhookSecret();
    try {
      const row = await this.prisma.$transaction(async (tx) => {
        const created = await tx.gitHubIntegration.create({
          data: {
            id,
            organizationId: orgId,
            projectId: input.projectId,
            serviceId: input.serviceId ?? null,
            repoFullName: input.repoFullName,
            webhookSecretEncrypted: encryptSecret(secret, this.key!, id),
          },
          select,
        });
        await this.audit.record(tx, tenant, requestId, {
          action: 'integration.github.created',
          resourceType: 'github_integration',
          resourceId: id,
          metadata: { repository: input.repoFullName },
        });
        return created;
      });
      return { ...toDto(row), webhookSecret: secret };
    } catch (error) {
      if ((error as { code?: string }).code === 'P2002') {
        throw ApiError.conflict(
          'INTEGRATION_EXISTS',
          'This repository already has an active integration in this organization',
        );
      }
      throw error;
    }
  }

  /** Disables the integration: deliveries are refused, history is kept, the repository is freed. */
  async disable(tenant: TenantContext, requestId: string | undefined, id: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const existing = await tx.gitHubIntegration.findFirst({
        where: { id, organizationId: tenant.organizationId, status: 'ACTIVE' },
        select: { repoFullName: true },
      });
      if (!existing) throw ApiError.notFound('Integration not found');
      await tx.gitHubIntegration.updateMany({
        where: { id, organizationId: tenant.organizationId },
        data: { status: 'DISABLED' },
      });
      await this.audit.record(tx, tenant, requestId, {
        action: 'integration.github.disabled',
        resourceType: 'github_integration',
        resourceId: id,
        metadata: { repository: existing.repoFullName },
      });
    });
  }
}
