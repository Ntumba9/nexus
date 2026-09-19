import { z } from 'zod';
import { incidentSeveritySchema, type IncidentSeverity } from './incidents';
import type { ServiceHealth } from './projects';

// ---- Vocabulary ------------------------------------------------------------------------------

export const CHECK_OUTCOMES = ['UP', 'DOWN'] as const;
export type CheckOutcome = (typeof CHECK_OUTCOMES)[number];

/** Why a check failed. A closed set: it is stored, filtered on and shown to users. */
export const FAILURE_REASONS = [
  'timeout',
  'dns_failure',
  'connection_refused',
  'connection_reset',
  'tls_error',
  'unexpected_status',
  'blocked_address',
  'invalid_url',
  'request_error',
] as const;
export type FailureReason = (typeof FAILURE_REASONS)[number];

export const FAILURE_REASON_LABEL: Record<FailureReason, string> = {
  timeout: 'Timed out',
  dns_failure: 'DNS lookup failed',
  connection_refused: 'Connection refused',
  connection_reset: 'Connection reset',
  tls_error: 'TLS / certificate error',
  unexpected_status: 'Unexpected status code',
  blocked_address: 'Address not allowed',
  invalid_url: 'Invalid URL',
  request_error: 'Request failed',
};

/** Hard limits, mirrored by CHECK constraints in the database. */
export const CHECK_LIMITS = {
  timeoutMs: { min: 100, max: 30_000 },
  intervalSeconds: { min: 15, max: 86_400 },
  failureThreshold: { min: 1, max: 20 },
  recoveryThreshold: { min: 1, max: 20 },
  maxChecksPerService: 5,
} as const;

// ---- The state machine ----------------------------------------------------------------------

export interface CheckState {
  health: 'UNKNOWN' | 'HEALTHY' | 'DOWN';
  consecutiveFailures: number;
  consecutiveSuccesses: number;
}

export type CheckTransition = 'WENT_DOWN' | 'RECOVERED' | null;

export interface CheckThresholds {
  /** Consecutive failures required before the check is considered DOWN. */
  failureThreshold: number;
  /** Consecutive successes required before a DOWN check is considered recovered. */
  recoveryThreshold: number;
}

const COUNTER_CAP = 1_000_000;

/**
 * The single rule for turning a stream of results into health. Pure, so it can be tested
 * exhaustively; the worker only persists what this returns.
 *
 *  - One transient failure does nothing on its own: DOWN needs `failureThreshold` failures in a row.
 *  - A DOWN check needs `recoveryThreshold` successes in a row to recover (avoids flapping).
 *  - A first success on a check that never had a verdict simply makes it HEALTHY.
 *  - Failures and successes reset each other's streak.
 */
export function evaluateCheck(
  state: CheckState,
  outcome: CheckOutcome,
  thresholds: CheckThresholds,
): { state: CheckState; transition: CheckTransition } {
  if (outcome === 'DOWN') {
    const consecutiveFailures = Math.min(state.consecutiveFailures + 1, COUNTER_CAP);
    const reachedThreshold = consecutiveFailures >= thresholds.failureThreshold;
    if (reachedThreshold && state.health !== 'DOWN') {
      return {
        state: { health: 'DOWN', consecutiveFailures, consecutiveSuccesses: 0 },
        transition: 'WENT_DOWN',
      };
    }
    return {
      state: { health: state.health, consecutiveFailures, consecutiveSuccesses: 0 },
      transition: null,
    };
  }

  const consecutiveSuccesses = Math.min(state.consecutiveSuccesses + 1, COUNTER_CAP);
  if (state.health === 'DOWN') {
    if (consecutiveSuccesses >= thresholds.recoveryThreshold) {
      return {
        state: { health: 'HEALTHY', consecutiveFailures: 0, consecutiveSuccesses },
        transition: 'RECOVERED',
      };
    }
    return {
      state: { health: 'DOWN', consecutiveFailures: 0, consecutiveSuccesses },
      transition: null,
    };
  }
  return {
    state: { health: 'HEALTHY', consecutiveFailures: 0, consecutiveSuccesses },
    transition: null,
  };
}

/**
 * A service's health is the worst of its enabled checks that have a verdict. With no verdicts it is
 * UNKNOWN ("not monitored"), never assumed healthy.
 */
export function aggregateServiceHealth(healths: ServiceHealth[]): ServiceHealth {
  if (healths.includes('DOWN')) return 'DOWN';
  if (healths.includes('DEGRADED')) return 'DEGRADED';
  if (healths.includes('HEALTHY')) return 'HEALTHY';
  return 'UNKNOWN';
}

// ---- Request schemas ------------------------------------------------------------------------

const nameSchema = z.string().trim().min(1, 'Name is required').max(60, 'Name is too long');
const urlSchema = z.string().trim().min(1, 'URL is required').max(2048, 'URL is too long');
const int = (min: number, max: number, label: string) =>
  z
    .number({ error: `${label} must be a number` })
    .int(`${label} must be a whole number`)
    .min(min, `${label} must be at least ${min}`)
    .max(max, `${label} must be at most ${max}`);

const checkFields = {
  name: nameSchema,
  url: urlSchema,
  expectedStatus: int(100, 599, 'Expected status'),
  timeoutMs: int(CHECK_LIMITS.timeoutMs.min, CHECK_LIMITS.timeoutMs.max, 'Timeout'),
  intervalSeconds: int(
    CHECK_LIMITS.intervalSeconds.min,
    CHECK_LIMITS.intervalSeconds.max,
    'Interval',
  ),
  failureThreshold: int(
    CHECK_LIMITS.failureThreshold.min,
    CHECK_LIMITS.failureThreshold.max,
    'Failure threshold',
  ),
  recoveryThreshold: int(
    CHECK_LIMITS.recoveryThreshold.min,
    CHECK_LIMITS.recoveryThreshold.max,
    'Recovery threshold',
  ),
  incidentSeverity: incidentSeveritySchema,
  createIncidents: z.boolean(),
  enabled: z.boolean(),
};

export const createCheckSchema = z.object({
  name: checkFields.name,
  url: checkFields.url,
  expectedStatus: checkFields.expectedStatus.default(200),
  timeoutMs: checkFields.timeoutMs.default(5000),
  intervalSeconds: checkFields.intervalSeconds.default(60),
  failureThreshold: checkFields.failureThreshold.default(3),
  recoveryThreshold: checkFields.recoveryThreshold.default(2),
  incidentSeverity: checkFields.incidentSeverity.default('SEV2'),
  createIncidents: checkFields.createIncidents.default(true),
  enabled: checkFields.enabled.default(true),
});
export type CreateCheckInput = z.infer<typeof createCheckSchema>;

export const updateCheckSchema = z
  .object(checkFields)
  .partial()
  .refine((value) => Object.keys(value).length > 0, 'Provide at least one field to update');
export type UpdateCheckInput = z.infer<typeof updateCheckSchema>;

export const listResultsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  /** Continue below this result's checkedAt (ISO timestamp); results are newest-first. */
  before: z.iso.datetime().optional(),
});
export type ListResultsQuery = z.infer<typeof listResultsQuerySchema>;

// ---- Response contracts ---------------------------------------------------------------------

export interface MonitoringCheckDto {
  id: string;
  serviceId: string;
  name: string;
  type: 'HTTP';
  url: string;
  expectedStatus: number;
  timeoutMs: number;
  intervalSeconds: number;
  failureThreshold: number;
  recoveryThreshold: number;
  incidentSeverity: IncidentSeverity;
  createIncidents: boolean;
  enabled: boolean;
  healthStatus: 'UNKNOWN' | 'HEALTHY' | 'DOWN';
  consecutiveFailures: number;
  lastCheckedAt: string | null;
  nextRunAt: string;
  createdAt: string;
}

export interface MonitoringResultDto {
  id: string;
  status: CheckOutcome;
  statusCode: number | null;
  responseTimeMs: number | null;
  failureReason: FailureReason | null;
  checkedAt: string;
}

export interface MonitoringResultPageDto {
  data: MonitoringResultDto[];
  /** Pass as `before` to fetch the next (older) page; null when there are no more. */
  nextBefore: string | null;
}
