import { z } from 'zod';

/**
 * Queue names are shared by producers (API) and consumers (workers) so a typo cannot silently
 * create a queue nobody reads. New queues are added in the phase that introduces their jobs.
 */
export const QUEUE_NAMES = {
  /** Infrastructure queue used to verify the Redis → BullMQ → worker pipeline end to end. */
  system: 'system',
} as const;
export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

export const SYSTEM_JOBS = { ping: 'ping' } as const;

export const systemPingPayloadSchema = z.object({
  /** Caller-supplied correlation id; echoed back so callers can match request to result. */
  nonce: z.string().min(1).max(64),
});
export type SystemPingPayload = z.infer<typeof systemPingPayloadSchema>;

export const systemPingResultSchema = z.object({
  nonce: z.string(),
  processedAt: z.string(),
});
export type SystemPingResult = z.infer<typeof systemPingResultSchema>;
