import { createHmac } from 'node:crypto';
import { FAILURE_REASON_LABEL, type Facts, type FailureReason } from '@nexus/shared';
import { decryptSecret } from '@nexus/shared/webhook-security';
import type { SafePoster } from '../safe-post';
import { linkFor, type ActionContext, type ActionOutcome } from './notify';

const DEFAULT_TIMEOUT_MS = 5000;

/** A failure that could pass on a second try (the network, or the receiver being overloaded). */
const RETRYABLE_REASONS = new Set<FailureReason>([
  'timeout',
  'dns_failure',
  'connection_refused',
  'connection_reset',
]);
const RETRYABLE_STATUS = (status: number) =>
  status === 408 || status === 425 || status === 429 || status >= 500;

/**
 * The exact bytes that are signed and sent. Receivers verify the signature over these bytes:
 *   X-Nexus-Signature-256: sha256=HMAC_SHA256(secret, `${X-Nexus-Timestamp}.${body}`)
 * Including the timestamp in the signed text lets a receiver reject a replayed request.
 */
export function buildWebhookRequest(input: {
  secret: string;
  organizationId: string;
  executionId: string;
  actionIndex: number;
  ruleName: string;
  trigger: string;
  facts: Facts;
  link: string;
  now?: Date;
}): { body: string; headers: Record<string, string> } {
  const now = input.now ?? new Date();
  const body = JSON.stringify({
    id: `${input.executionId}:${input.actionIndex}`,
    type: input.trigger,
    createdAt: now.toISOString(),
    organizationId: input.organizationId,
    rule: { name: input.ruleName },
    data: input.facts,
    link: input.link,
  });
  const timestamp = String(Math.floor(now.getTime() / 1000));
  const signature = createHmac('sha256', input.secret).update(`${timestamp}.${body}`).digest('hex');
  return {
    body,
    headers: {
      'content-type': 'application/json',
      'user-agent': 'NEXUS-Webhooks/1',
      'x-nexus-event': input.trigger,
      // Constant across retries, so a receiver can deduplicate.
      'x-nexus-delivery': `${input.executionId}:${input.actionIndex}`,
      'x-nexus-timestamp': timestamp,
      'x-nexus-signature-256': `sha256=${signature}`,
    },
  };
}

/**
 * The `webhook` action: one signed JSON POST to an organization-managed destination. The destination
 * is looked up by (organization, id), so a rule can never reach another tenant's destination, and it
 * must still exist and be enabled NOW. The signing secret is decrypted only here, in memory, and is
 * never logged, stored in a result, or sent.
 */
export function createWebhookHandler(deps: {
  key: Buffer | undefined;
  post: SafePoster;
  timeoutMs?: number;
}) {
  return async (
    ctx: ActionContext,
    action: { type: 'webhook'; destinationId: string },
  ): Promise<ActionOutcome> => {
    if (!deps.key) {
      return { status: 'FAILED', detail: 'outbound webhooks are not enabled on this server' };
    }
    const destination = await ctx.prisma.outboundWebhook.findFirst({
      where: { id: action.destinationId, organizationId: ctx.organizationId, enabled: true },
      select: { id: true, url: true, secretEncrypted: true },
    });
    if (!destination) {
      return {
        status: 'FAILED',
        detail: 'the webhook destination no longer exists or is disabled',
      };
    }

    let secret: string;
    try {
      secret = decryptSecret(destination.secretEncrypted, deps.key, destination.id);
    } catch {
      ctx.logger.error('cannot decrypt an outbound webhook secret', {
        destinationId: destination.id,
      });
      return { status: 'FAILED', detail: 'the webhook secret could not be read' };
    }

    const request = buildWebhookRequest({
      secret,
      organizationId: ctx.organizationId,
      executionId: ctx.executionId,
      actionIndex: ctx.actionIndex,
      ruleName: ctx.ruleName,
      trigger: ctx.trigger,
      facts: ctx.facts,
      link: linkFor(ctx.organizationId, ctx.trigger, ctx.facts),
    });
    const result = await deps.post({
      url: destination.url,
      headers: request.headers,
      body: request.body,
      timeoutMs: deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });

    if (result.ok) return { status: 'SUCCEEDED', detail: `delivered (HTTP ${result.statusCode})` };
    if (result.statusCode !== undefined) {
      return {
        status: 'FAILED',
        detail: `the receiver answered HTTP ${result.statusCode}`,
        retryable: RETRYABLE_STATUS(result.statusCode),
      };
    }
    // The detail names the kind of failure, never the URL (which may carry a token).
    return {
      status: 'FAILED',
      detail: `could not deliver: ${FAILURE_REASON_LABEL[result.reason].toLowerCase()}`,
      retryable: RETRYABLE_REASONS.has(result.reason),
    };
  };
}
