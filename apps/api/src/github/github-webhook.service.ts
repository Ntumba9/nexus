import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ApiEnv } from '@nexus/config';
import type { Prisma, PrismaClient } from '@nexus/database';
import { isHandledGitHubEvent, WEBHOOK_JOBS, type WebhookProcessingPayload } from '@nexus/shared';
import {
  decryptSecret,
  parseEncryptionKey,
  verifyGitHubSignature,
} from '@nexus/shared/webhook-security';
import type { Queue } from 'bullmq';
import { ApiError } from '../common/api-error';
import { ENV, PRISMA, WEBHOOK_QUEUE } from '../infrastructure/tokens';
import { RateLimiter } from '../rate-limit/rate-limiter';
import { RATE_LIMITER } from '../rate-limit/tokens';

export interface WebhookDelivery {
  integrationId: string;
  /** The exact bytes received; the signature is computed over these, never over re-serialised JSON. */
  rawBody: Buffer | undefined;
  body: unknown;
  isJson: boolean;
  signature: string | undefined;
  deliveryId: string | undefined;
  eventType: string | undefined;
  ip: string;
}

export type WebhookOutcome = 'accepted' | 'duplicate' | 'ignored';

/** Per source address. GitHub sends a handful of deliveries per event, so this is generous. */
const REQUESTS_PER_MINUTE = 300;
/** Failed signatures per (integration, address) per 15 minutes before answers become 429. */
const BAD_SIGNATURES_PER_WINDOW = 10;
const BAD_SIGNATURE_WINDOW_SECONDS = 900;

const DELIVERY_ID = /^[A-Za-z0-9._:-]{1,100}$/;
const EVENT_TYPE = /^[a-z_]{1,100}$/;

@Injectable()
export class GitHubWebhookService {
  private readonly logger = new Logger(GitHubWebhookService.name);
  private readonly key: Buffer | undefined;

  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(WEBHOOK_QUEUE) private readonly queue: Queue,
    @Inject(RATE_LIMITER) private readonly limiter: RateLimiter,
    @Inject(ENV) env: ApiEnv,
  ) {
    this.key = env.INTEGRATION_ENCRYPTION_KEY
      ? parseEncryptionKey(env.INTEGRATION_ENCRYPTION_KEY)
      : undefined;
  }

  /**
   * Authenticates a delivery by its HMAC signature, records it once, and hands it to a worker.
   * Nothing about the payload is trusted, stored or acted on until the signature has verified.
   */
  async receive(delivery: WebhookDelivery): Promise<WebhookOutcome> {
    await this.limiter.consume('github-webhook', delivery.ip, REQUESTS_PER_MINUTE, 60);

    const integration = await this.prisma.gitHubIntegration.findUnique({
      where: { id: delivery.integrationId },
      select: { id: true, organizationId: true, status: true, webhookSecretEncrypted: true },
    });
    if (!integration || integration.status !== 'ACTIVE') throw ApiError.notFound('Not found');
    if (!this.key) {
      throw ApiError.unavailable('INTEGRATIONS_NOT_CONFIGURED', 'Integrations are not enabled');
    }

    let secret: string;
    try {
      secret = decryptSecret(integration.webhookSecretEncrypted, this.key, integration.id);
    } catch {
      // Wrong key or corrupted row: an operator problem, never the sender's. Do not leak details.
      this.logger.error(`Cannot decrypt the secret of integration ${integration.id}`);
      throw ApiError.unavailable('INTEGRATION_UNAVAILABLE', 'Integration temporarily unavailable');
    }

    if (!delivery.rawBody || !verifyGitHubSignature(secret, delivery.rawBody, delivery.signature)) {
      await this.limiter.consume(
        'github-webhook-bad-signature',
        `${integration.id}:${delivery.ip}`,
        BAD_SIGNATURES_PER_WINDOW,
        BAD_SIGNATURE_WINDOW_SECONDS,
      );
      this.logger.warn(`Rejected delivery with an invalid signature for ${integration.id}`);
      throw ApiError.unauthenticated('INVALID_SIGNATURE', 'Invalid signature');
    }

    // --- From here the sender is authenticated. ---
    if (!delivery.isJson) {
      throw ApiError.badRequest(
        'UNSUPPORTED_CONTENT_TYPE',
        'Configure the webhook with content type application/json',
      );
    }
    const { deliveryId, eventType } = delivery;
    if (!deliveryId || !DELIVERY_ID.test(deliveryId) || !eventType || !EVENT_TYPE.test(eventType)) {
      throw ApiError.badRequest('BAD_WEBHOOK_HEADERS', 'Missing or malformed GitHub headers');
    }

    await this.prisma.gitHubIntegration.update({
      where: { id: integration.id },
      data: { lastEventAt: new Date() },
      select: { id: true },
    });

    // Event types NEXUS does not act on are acknowledged without being stored.
    if (!isHandledGitHubEvent(eventType)) return 'ignored';

    let eventId: string;
    try {
      const event = await this.prisma.webhookEvent.create({
        data: {
          organizationId: integration.organizationId,
          integrationId: integration.id,
          deliveryId,
          eventType,
          payload: delivery.body as Prisma.InputJsonValue,
        },
        select: { id: true },
      });
      eventId = event.id;
    } catch (error) {
      // Unique (integration, delivery): GitHub redelivered something we already have.
      if ((error as { code?: string }).code === 'P2002') return 'duplicate';
      throw error;
    }

    const payload: WebhookProcessingPayload = {
      webhookEventId: eventId,
      organizationId: integration.organizationId,
    };
    try {
      await this.queue.add(WEBHOOK_JOBS.process, payload, {
        jobId: eventId,
        attempts: 5,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: 1000,
        removeOnFail: 5000,
      });
    } catch (error) {
      // Forget the delivery so GitHub's redelivery is processed rather than dropped as a duplicate.
      await this.prisma.webhookEvent.delete({ where: { id: eventId } }).catch(() => undefined);
      this.logger.error(
        `Could not enqueue webhook processing: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw ApiError.unavailable('QUEUE_UNAVAILABLE', 'Temporarily unable to accept deliveries');
    }
    return 'accepted';
  }
}
