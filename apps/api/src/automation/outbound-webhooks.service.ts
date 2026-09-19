import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { ApiEnv } from '@nexus/config';
import type { Prisma, PrismaClient } from '@nexus/database';
import {
  AUTOMATION_LIMITS,
  type CreateOutboundWebhookInput,
  type CreatedOutboundWebhookDto,
  type OutboundWebhookDto,
} from '@nexus/shared';
import { validateMonitoringUrl } from '@nexus/shared/net-safety';
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
  name: true,
  url: true,
  enabled: true,
  createdAt: true,
} satisfies Prisma.OutboundWebhookSelect;
type Row = Prisma.OutboundWebhookGetPayload<{ select: typeof select }>;

/** Origin and path only: the query string may carry a token, so it is never shown again. */
function displayUrl(raw: string): string {
  try {
    const url = new URL(raw);
    return `${url.origin}${url.pathname}`;
  } catch {
    return '';
  }
}

const toDto = (row: Row): OutboundWebhookDto => ({
  id: row.id,
  name: row.name,
  url: displayUrl(row.url),
  enabled: row.enabled,
  createdAt: row.createdAt.toISOString(),
});

@Injectable()
export class OutboundWebhooksService {
  private readonly key: Buffer | undefined;
  private readonly allowPrivate: boolean;

  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(ENV) env: ApiEnv,
  ) {
    this.key = env.INTEGRATION_ENCRYPTION_KEY
      ? parseEncryptionKey(env.INTEGRATION_ENCRYPTION_KEY)
      : undefined;
    this.allowPrivate = env.MONITORING_ALLOW_PRIVATE_NETWORKS;
  }

  async list(tenant: TenantContext): Promise<OutboundWebhookDto[]> {
    const rows = await this.prisma.outboundWebhook.findMany({
      where: { organizationId: tenant.organizationId, enabled: true },
      orderBy: { createdAt: 'desc' },
      select,
    });
    return rows.map(toDto);
  }

  /** Creates a destination and returns its signing secret, which is never shown again. */
  async create(
    tenant: TenantContext,
    requestId: string | undefined,
    input: CreateOutboundWebhookInput,
  ): Promise<CreatedOutboundWebhookDto> {
    if (!this.key) {
      throw ApiError.unavailable(
        'INTEGRATIONS_NOT_CONFIGURED',
        'Outbound webhooks are not enabled on this server (INTEGRATION_ENCRYPTION_KEY is not set)',
      );
    }
    // The same SSRF rules as monitoring. The worker checks again at send time; this is the early,
    // friendly refusal, not the only line of defence.
    const checked = validateMonitoringUrl(input.url, { allowPrivate: this.allowPrivate });
    if (!checked.ok) throw ApiError.badRequest('URL_NOT_ALLOWED', checked.reason);

    // The id is generated first because it is bound into the ciphertext as authenticated data.
    const id = randomUUID();
    const secret = generateWebhookSecret();
    const key = this.key;
    const row = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT 1 FROM "Organization" WHERE "id" = ${tenant.organizationId}::uuid FOR UPDATE`;
      const count = await tx.outboundWebhook.count({
        where: { organizationId: tenant.organizationId, enabled: true },
      });
      if (count >= AUTOMATION_LIMITS.maxWebhooksPerOrganization) {
        throw ApiError.conflict(
          'WEBHOOK_LIMIT',
          `An organization can have at most ${AUTOMATION_LIMITS.maxWebhooksPerOrganization} outbound webhooks`,
        );
      }
      const created = await tx.outboundWebhook.create({
        data: {
          id,
          organizationId: tenant.organizationId,
          name: input.name,
          url: checked.url.toString(),
          secretEncrypted: encryptSecret(secret, key, id),
          createdById: tenant.userId,
        },
        select,
      });
      await this.audit.record(tx, tenant, requestId, {
        action: 'outbound_webhook.created',
        resourceType: 'outbound_webhook',
        resourceId: id,
        metadata: { name: input.name, url: displayUrl(input.url) },
      });
      return created;
    });
    return { ...toDto(row), signingSecret: secret };
  }

  /** Disables the destination. Rules that still point at it fail clearly instead of sending. */
  async disable(tenant: TenantContext, requestId: string | undefined, id: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const existing = await tx.outboundWebhook.findFirst({
        where: { id, organizationId: tenant.organizationId, enabled: true },
        select: { name: true },
      });
      if (!existing) throw ApiError.notFound('Webhook not found');
      await tx.outboundWebhook.updateMany({
        where: { id, organizationId: tenant.organizationId },
        data: { enabled: false },
      });
      await this.audit.record(tx, tenant, requestId, {
        action: 'outbound_webhook.disabled',
        resourceType: 'outbound_webhook',
        resourceId: id,
        metadata: { name: existing.name },
      });
    });
  }
}
