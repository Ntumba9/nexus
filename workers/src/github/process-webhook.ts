import { emitDeploymentStatusEvent, type PrismaClient } from '@nexus/database';
import { normaliseDeploymentStatus, type WebhookProcessingPayload } from '@nexus/shared';

export type WebhookProcessingOutcome =
  | { status: 'processed'; deploymentId?: string }
  | { status: 'ignored' }
  | { status: 'failed'; reason: string }
  /** Nothing to do: the event is gone (retention) or was already handled by an earlier attempt. */
  | { status: 'skipped'; reason: string };

/**
 * Turns one stored, signature-verified GitHub delivery into domain data.
 *
 * Idempotent: an event that is no longer RECEIVED is skipped, and deployments are upserted on
 * (integration, GitHub deployment id), so a retried job or a redelivered event changes nothing.
 * Permanent problems (malformed payload, wrong repository) mark the event FAILED and are NOT thrown,
 * because retrying cannot fix them. Only transient errors (database) propagate for BullMQ to retry.
 */
export async function processWebhookEvent(
  deps: { prisma: PrismaClient },
  payload: WebhookProcessingPayload,
): Promise<WebhookProcessingOutcome> {
  const { prisma } = deps;
  const event = await prisma.webhookEvent.findFirst({
    where: { id: payload.webhookEventId, organizationId: payload.organizationId },
    select: {
      id: true,
      status: true,
      eventType: true,
      payload: true,
      integration: {
        select: { id: true, projectId: true, serviceId: true, repoFullName: true, status: true },
      },
    },
  });
  if (!event) return { status: 'skipped', reason: 'event no longer exists' };
  if (event.status !== 'RECEIVED') return { status: 'skipped', reason: `already ${event.status}` };

  const finish = (status: 'PROCESSED' | 'IGNORED' | 'FAILED', error?: string) =>
    prisma.webhookEvent.update({
      where: { id: event.id },
      data: { status, error: error ?? null, processedAt: new Date() },
      select: { id: true },
    });

  if (event.eventType === 'ping') {
    await finish('PROCESSED');
    return { status: 'processed' };
  }
  if (event.eventType !== 'deployment_status') {
    await finish('IGNORED');
    return { status: 'ignored' };
  }

  const normalised = normaliseDeploymentStatus(event.payload);
  if (!normalised.ok) {
    await finish('FAILED', normalised.reason);
    return { status: 'failed', reason: normalised.reason };
  }
  const incoming = normalised.deployment;
  const { integration } = event;
  // A valid signature proves the sender holds this integration's secret, not that the event is
  // about this integration's repository, so that is checked as well.
  if (incoming.repoFullName.toLowerCase() !== integration.repoFullName.toLowerCase()) {
    const reason = 'event is for a different repository than the integration';
    await finish('FAILED', reason);
    return { status: 'failed', reason };
  }

  const deploymentId = await prisma.$transaction(async (tx) => {
    const existing = await tx.deployment.findUnique({
      where: {
        integrationId_externalId: {
          integrationId: integration.id,
          externalId: incoming.externalId,
        },
      },
      select: { id: true, status: true, statusUpdatedAt: true, deployedAt: true },
    });
    let id: string;
    if (!existing) {
      const created = await tx.deployment.create({
        data: {
          organizationId: payload.organizationId,
          projectId: integration.projectId,
          serviceId: integration.serviceId,
          integrationId: integration.id,
          externalId: incoming.externalId,
          environment: incoming.environment,
          ref: incoming.ref,
          commitSha: incoming.commitSha,
          status: incoming.status,
          author: incoming.author,
          description: incoming.description,
          startedAt: incoming.startedAt,
          deployedAt: incoming.status === 'SUCCESS' ? incoming.statusAt : null,
          statusUpdatedAt: incoming.statusAt,
        },
        select: { id: true },
      });
      id = created.id;
      // A deployment first seen already finished is announced like one that just finished.
      await emitDeploymentStatusEvent(tx, payload.organizationId, id);
    } else {
      id = existing.id;
      // Statuses can arrive out of order; only a newer one changes the deployment.
      if (incoming.statusAt >= existing.statusUpdatedAt) {
        await tx.deployment.update({
          where: { id },
          data: {
            status: incoming.status,
            description: incoming.description,
            statusUpdatedAt: incoming.statusAt,
            // The first SUCCESS is when it shipped; later updates never move it.
            deployedAt:
              existing.deployedAt ?? (incoming.status === 'SUCCESS' ? incoming.statusAt : null),
          },
          select: { id: true },
        });
        // Announce a change into SUCCESS or FAILURE, never a repeat of the status it already had.
        if (incoming.status !== existing.status) {
          await emitDeploymentStatusEvent(tx, payload.organizationId, id);
        }
      }
    }
    await tx.webhookEvent.update({
      where: { id: event.id },
      data: { status: 'PROCESSED', error: null, processedAt: new Date() },
      select: { id: true },
    });
    return id;
  });
  return { status: 'processed', deploymentId };
}

/** Called when a job has used all its attempts: record it so the event is not stuck in RECEIVED. */
export async function markWebhookEventFailed(
  prisma: PrismaClient,
  payload: WebhookProcessingPayload,
  reason: string,
): Promise<void> {
  await prisma.webhookEvent.updateMany({
    where: {
      id: payload.webhookEventId,
      organizationId: payload.organizationId,
      status: 'RECEIVED',
    },
    data: { status: 'FAILED', error: reason.slice(0, 500), processedAt: new Date() },
  });
}
