import { z } from 'zod';
import { roleHasPermission, type Permission, type Role } from './permissions';

// ---- Enums (mirrored by the Prisma schema; the database enforces the same values) -------------

export const INCIDENT_SEVERITIES = ['SEV1', 'SEV2', 'SEV3', 'SEV4'] as const;
export const incidentSeveritySchema = z.enum(INCIDENT_SEVERITIES);
export type IncidentSeverity = z.infer<typeof incidentSeveritySchema>;

/** Human label, e.g. "SEV-1". Never build these strings ad hoc elsewhere. */
export const SEVERITY_LABEL: Record<IncidentSeverity, string> = {
  SEV1: 'SEV-1',
  SEV2: 'SEV-2',
  SEV3: 'SEV-3',
  SEV4: 'SEV-4',
};

export const SEVERITY_DESCRIPTION: Record<IncidentSeverity, string> = {
  SEV1: 'Critical: full outage or data loss',
  SEV2: 'Major: significant degradation',
  SEV3: 'Minor: limited impact',
  SEV4: 'Low: cosmetic or no user impact',
};

export const INCIDENT_STATUSES = [
  'OPEN',
  'ACKNOWLEDGED',
  'INVESTIGATING',
  'MITIGATED',
  'RESOLVED',
  'CANCELLED',
] as const;
export const incidentStatusSchema = z.enum(INCIDENT_STATUSES);
export type IncidentStatus = z.infer<typeof incidentStatusSchema>;

export const INCIDENT_SOURCES = ['MANUAL', 'MONITORING', 'AUTOMATION', 'WEBHOOK'] as const;
export type IncidentSource = (typeof INCIDENT_SOURCES)[number];

export const INCIDENT_EVENT_TYPES = [
  'CREATED',
  'UPDATED',
  'STATUS_CHANGED',
  'SEVERITY_CHANGED',
  'ASSIGNED',
  'UNASSIGNED',
  'COMMENT_ADDED',
  /** Recorded by monitoring on an incident it created (for example "the service recovered"). */
  'MONITORING_SIGNAL',
  'DEPLOYMENT_LINKED',
  /** Recorded when an automation rule ran because of this incident. */
  'AUTOMATION_EXECUTED',
  'AI_INVESTIGATED',
] as const;
export type IncidentEventType = (typeof INCIDENT_EVENT_TYPES)[number];

export const ACTOR_TYPES = ['USER', 'SYSTEM', 'AUTOMATION', 'AI'] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];

// ---- Lifecycle state machine ---------------------------------------------------------------

/**
 * The single definition of which status changes are legal.
 *
 *   OPEN → ACKNOWLEDGED → INVESTIGATING → MITIGATED → RESOLVED
 *
 * with shortcuts forward (an incident can be resolved without passing every step), regression
 * from MITIGATED back to INVESTIGATING, reopening a RESOLVED incident, and cancellation from any
 * unresolved state. CANCELLED is terminal. The API enforces this on every transition; the web app
 * only uses it to decide which buttons to show.
 */
export const INCIDENT_TRANSITIONS: Readonly<Record<IncidentStatus, readonly IncidentStatus[]>> = {
  OPEN: ['ACKNOWLEDGED', 'CANCELLED'],
  ACKNOWLEDGED: ['INVESTIGATING', 'MITIGATED', 'RESOLVED', 'CANCELLED'],
  INVESTIGATING: ['MITIGATED', 'RESOLVED', 'CANCELLED'],
  MITIGATED: ['INVESTIGATING', 'RESOLVED', 'CANCELLED'],
  RESOLVED: ['INVESTIGATING'],
  CANCELLED: [],
};

export function canTransition(from: IncidentStatus, to: IncidentStatus): boolean {
  return INCIDENT_TRANSITIONS[from].includes(to);
}

/** Closing or reopening an incident is a stronger action than moving it along. */
export function permissionForTransition(from: IncidentStatus, to: IncidentStatus): Permission {
  return to === 'RESOLVED' || from === 'RESOLVED' ? 'incidents.resolve' : 'incidents.update';
}

/** Transitions this role may perform from `from`: legal per the state machine AND permitted. */
export function allowedTransitions(from: IncidentStatus, role: Role): IncidentStatus[] {
  return INCIDENT_TRANSITIONS[from].filter((to) =>
    roleHasPermission(role, permissionForTransition(from, to)),
  );
}

/** Active = still needs attention (drives the dashboard's "active incidents"). */
export const ACTIVE_STATUSES: readonly IncidentStatus[] = [
  'OPEN',
  'ACKNOWLEDGED',
  'INVESTIGATING',
  'MITIGATED',
];

export function isActiveStatus(status: IncidentStatus): boolean {
  return ACTIVE_STATUSES.includes(status);
}

/** Sort key: lower is more urgent. */
export function severityRank(severity: IncidentSeverity): number {
  return INCIDENT_SEVERITIES.indexOf(severity);
}

// ---- Request schemas -----------------------------------------------------------------------

const tagSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9-]{0,29}$/, 'Tags use lowercase letters, numbers and hyphens (max 30)');

const tagsSchema = z
  .array(tagSchema)
  .max(10, 'At most 10 tags')
  .transform((tags) => [...new Set(tags)]);

export const createIncidentSchema = z.object({
  title: z.string().trim().min(1, 'Title is required').max(200, 'Title is too long'),
  description: z.string().trim().max(10_000, 'Description is too long').default(''),
  severity: incidentSeveritySchema,
  serviceId: z.uuid().nullable().optional(),
  tags: tagsSchema.default([]),
});
export type CreateIncidentInput = z.infer<typeof createIncidentSchema>;

export const updateIncidentSchema = z
  .object({
    title: z.string().trim().min(1, 'Title is required').max(200, 'Title is too long'),
    description: z.string().trim().max(10_000, 'Description is too long'),
    severity: incidentSeveritySchema,
    tags: tagsSchema,
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, 'Provide at least one field to update');
export type UpdateIncidentInput = z.infer<typeof updateIncidentSchema>;

export const transitionIncidentSchema = z.object({
  to: incidentStatusSchema,
  note: z.string().trim().max(1000, 'Note is too long').optional(),
});
export type TransitionIncidentInput = z.infer<typeof transitionIncidentSchema>;

export const addCommentSchema = z.object({
  body: z.string().trim().min(1, 'Comment cannot be empty').max(5000, 'Comment is too long'),
});
export type AddCommentInput = z.infer<typeof addCommentSchema>;

export const setAssigneesSchema = z.object({
  userIds: z
    .array(z.uuid())
    .max(10, 'At most 10 assignees')
    .transform((ids) => [...new Set(ids)]),
});
export type SetAssigneesInput = z.infer<typeof setAssigneesSchema>;

export const listIncidentsQuerySchema = z.object({
  status: z
    .string()
    .optional()
    .transform((value) => (value ? value.split(',').filter(Boolean) : undefined))
    .pipe(z.array(incidentStatusSchema).optional()),
  severity: z
    .string()
    .optional()
    .transform((value) => (value ? value.split(',').filter(Boolean) : undefined))
    .pipe(z.array(incidentSeveritySchema).optional()),
  serviceId: z.uuid().optional(),
  q: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  /** Incident number to continue below (results are newest-first). */
  cursor: z.coerce.number().int().min(1).optional(),
});
export type ListIncidentsQuery = z.infer<typeof listIncidentsQuerySchema>;

// ---- Response contracts --------------------------------------------------------------------

export interface IncidentServiceRefDto {
  id: string;
  name: string;
  environment: string;
}

export interface IncidentPersonDto {
  id: string;
  name: string;
}

export interface IncidentSummaryDto {
  id: string;
  number: number;
  title: string;
  severity: IncidentSeverity;
  status: IncidentStatus;
  source: IncidentSource;
  service: IncidentServiceRefDto | null;
  assignees: IncidentPersonDto[];
  tags: string[];
  createdAt: string;
  updatedAt: string;
  acknowledgedAt: string | null;
  resolvedAt: string | null;
}

export interface IncidentDetailDto extends IncidentSummaryDto {
  description: string;
  mitigatedAt: string | null;
  cancelledAt: string | null;
  createdBy: IncidentPersonDto | null;
  /** Transitions the *caller* may perform right now (legal + permitted). */
  allowedTransitions: IncidentStatus[];
}

export interface IncidentEventDto {
  id: string;
  type: IncidentEventType;
  actorType: ActorType;
  actor: IncidentPersonDto | null;
  data: Record<string, unknown>;
  createdAt: string;
}

export interface IncidentPageDto {
  data: IncidentSummaryDto[];
  nextCursor: number | null;
}
