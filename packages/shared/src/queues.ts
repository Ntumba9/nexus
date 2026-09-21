import { z } from 'zod';

/**
 * Queue names are shared by producers (API) and consumers (workers) so a typo cannot silently
 * create a queue nobody reads. New queues are added in the phase that introduces their jobs.
 */
export const QUEUE_NAMES = {
  /** Infrastructure queue used to verify the Redis → BullMQ → worker pipeline end to end. */
  system: 'system',
  /** One job per scheduled execution of a monitoring check. */
  healthCheck: 'health-check',
  /** Periodic housekeeping (retention). */
  maintenance: 'maintenance',
  /** One job per stored GitHub webhook delivery. */
  webhookProcessing: 'webhook-processing',
  /** One job per automation execution (a rule matched an event). */
  automation: 'automation',
  /** One job per knowledge document whose chunks need embedding. */
  knowledge: 'knowledge',
  /** One job per AI investigation. */
  ai: 'ai-investigation',
  /** Transactional email (password reset). */
  email: 'email',
} as const;
export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

export const SYSTEM_JOBS = { ping: 'ping' } as const;
export const HEALTH_CHECK_JOBS = { run: 'run' } as const;
export const WEBHOOK_JOBS = { process: 'process' } as const;
export const AUTOMATION_JOBS = { execute: 'execute' } as const;
export const KNOWLEDGE_JOBS = { embed: 'embed' } as const;
export const AI_JOBS = { investigate: 'investigate' } as const;
export const EMAIL_JOBS = { passwordReset: 'password-reset' } as const;

/**
 * Asks the worker to email a password-reset link. The address is never in the payload: the worker
 * looks the person up, so a job can only ever reach the account it names. The token is (see ADR-017)
 * the one secret that crosses Redis, so jobs are removed as soon as they finish.
 */
export const passwordResetJobSchema = z.object({
  userId: z.uuid(),
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  requestId: z.string().max(64).optional(),
});
export type PasswordResetJob = z.infer<typeof passwordResetJobSchema>;
export const MAINTENANCE_JOBS = {
  cleanupResults: 'cleanup-results',
  cleanupWebhooks: 'cleanup-webhooks',
  cleanupAutomation: 'cleanup-automation',
} as const;

/**
 * A scheduled execution of one check. `scheduledFor` identifies the execution slot: together with
 * the check id it is unique in the database, so a retried or duplicated job is recognised and
 * recorded only once (idempotency).
 */
export const healthCheckPayloadSchema = z.object({
  checkId: z.uuid(),
  organizationId: z.uuid(),
  scheduledFor: z.iso.datetime(),
});
export type HealthCheckPayload = z.infer<typeof healthCheckPayloadSchema>;

export const maintenancePayloadSchema = z.object({ slot: z.string().min(1).max(64) });
export type MaintenancePayload = z.infer<typeof maintenancePayloadSchema>;

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
