import { z } from 'zod';

/** A URL string restricted to the given protocols (each including the trailing colon). */
const urlWithProtocol = (protocols: string[], label: string) =>
  z.string().refine(
    (value) => {
      try {
        return protocols.includes(new URL(value).protocol);
      } catch {
        return false;
      }
    },
    { message: `must be a valid ${label} URL` },
  );

/**
 * Base64 of exactly 32 random bytes (`openssl rand -base64 32`). Used to encrypt integration secrets
 * at rest. Optional: integrations are disabled when unset, and the rest of the product keeps working.
 */
const encryptionKey = z
  .string()
  .optional()
  .transform((value) => value?.trim() || undefined)
  .refine((value) => value === undefined || Buffer.from(value, 'base64').length === 32, {
    message: 'must be base64 of exactly 32 bytes (generate with: openssl rand -base64 32)',
  });

const port = z.coerce.number().int().min(1).max(65535);

const baseEnv = {
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
};

/**
 * Operator opt-in to monitor private/internal addresses (localhost, 10.x, 192.168.x…). Off by
 * default: with it off, monitoring cannot be used to probe the network the platform runs in (SSRF).
 * Turn it on for self-hosted setups that monitor internal services, for local development and tests.
 */
const monitoringPrivateNetworks = z
  .enum(['true', 'false'])
  .default('false')
  .transform((value) => value === 'true');

const databaseUrl = urlWithProtocol(['postgresql:', 'postgres:'], 'PostgreSQL');
const redisUrl = urlWithProtocol(['redis:', 'rediss:'], 'Redis');
const httpUrl = urlWithProtocol(['http:', 'https:'], 'HTTP(S)');

export const apiEnvSchema = z.object({
  ...baseEnv,
  DATABASE_URL: databaseUrl,
  REDIS_URL: redisUrl,
  API_HOST: z.string().min(1).default('0.0.0.0'),
  API_PORT: port.default(3001),
  /** Browser origin allowed by CORS. */
  WEB_ORIGIN: httpUrl.default('http://localhost:3000'),
  SWAGGER_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
  /** Number of reverse-proxy hops to trust for client IP (X-Forwarded-For). 0 = trust none. */
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
  /** Set the Secure flag on the session cookie. Defaults to true in production. */
  COOKIE_SECURE: z.enum(['true', 'false']).optional(),
  /** Idle session lifetime (sliding), in hours. */
  SESSION_IDLE_TTL_HOURS: z.coerce
    .number()
    .int()
    .min(1)
    .max(24 * 90)
    .default(24 * 7),
  /** Hard cap on session lifetime regardless of activity, in days. */
  SESSION_ABSOLUTE_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  /** Auth rate limit: attempts per window per account. Per-IP limits are derived from this. */
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().min(1).max(100000).default(10),
  AUTH_RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().min(1).max(86400).default(900),
  MONITORING_ALLOW_PRIVATE_NETWORKS: monitoringPrivateNetworks,
  INTEGRATION_ENCRYPTION_KEY: encryptionKey,
  /**
   * Optional: AI features are disabled when unset (the rest of the product must keep working).
   * Read only from the environment; never logged, never sent to the browser.
   */
  ANTHROPIC_API_KEY: z
    .string()
    .optional()
    .transform((value) => value?.trim() || undefined),
});
export type ApiEnv = z.infer<typeof apiEnvSchema>;

export const workerEnvSchema = z.object({
  ...baseEnv,
  DATABASE_URL: databaseUrl,
  REDIS_URL: redisUrl,
  MONITORING_ALLOW_PRIVATE_NETWORKS: monitoringPrivateNetworks,
  /** How often the dispatcher looks for checks that are due. */
  MONITORING_DISPATCH_INTERVAL_MS: z.coerce.number().int().min(250).max(60_000).default(5000),
  /** Monitoring results older than this are deleted by the maintenance job. */
  MONITORING_RESULT_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(30),
  /** Stored webhook deliveries (which include the payload) older than this are deleted. */
  WEBHOOK_RETENTION_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  /** How often the automation dispatcher looks for new domain events. */
  AUTOMATION_DISPATCH_INTERVAL_MS: z.coerce.number().int().min(250).max(60_000).default(1000),
  /** A rule that has already run this many times in the last hour is skipped (and the skip is recorded). */
  AUTOMATION_MAX_EXECUTIONS_PER_RULE_PER_HOUR: z.coerce
    .number()
    .int()
    .min(1)
    .max(10_000)
    .default(60),
  /** The same key the API uses: needed here to decrypt outbound webhook signing secrets. */
  INTEGRATION_ENCRYPTION_KEY: encryptionKey,
  /** Dispatched domain events and automation executions older than this are deleted. */
  AUTOMATION_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(90),
  /** Notifications older than this are deleted. */
  NOTIFICATION_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(90),
  /** `log` writes emails to the worker log (no external service); `smtp` sends them. */
  EMAIL_TRANSPORT: z.enum(['log', 'smtp']).default('log'),
  /** smtp:// or smtps:// URL, credentials included. A secret: never logged. Required for `smtp`. */
  SMTP_URL: z
    .string()
    .optional()
    .transform((value) => value?.trim() || undefined)
    .refine((value) => value === undefined || /^smtps?:\/\//i.test(value), {
      message: 'must be an smtp:// or smtps:// URL',
    }),
  EMAIL_FROM: z.string().trim().min(3).max(200).default('NEXUS <nexus@localhost>'),
  /** Origin of the web app: emails link back to it. */
  WEB_ORIGIN: httpUrl.default('http://localhost:3000'),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(100).default(5),
  WORKER_HEALTH_HOST: z.string().min(1).default('0.0.0.0'),
  WORKER_HEALTH_PORT: port.default(3002),
});
export type WorkerEnv = z.infer<typeof workerEnvSchema>;

/** Server-side web configuration. Never expose these values to the browser. */
export const webEnvSchema = z.object({
  ...baseEnv,
  /** Where the Next.js server reaches the API (differs from the browser URL inside Docker). */
  API_INTERNAL_URL: httpUrl.default('http://localhost:3001'),
});
export type WebEnv = z.infer<typeof webEnvSchema>;
