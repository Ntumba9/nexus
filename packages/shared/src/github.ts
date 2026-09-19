import { z } from 'zod';

/** How far before an incident a successful deployment is suggested as a possible cause. */
export const DEPLOYMENT_SUGGESTION_WINDOW_MINUTES = 120;

export const DEPLOYMENT_STATUSES = [
  'PENDING',
  'IN_PROGRESS',
  'SUCCESS',
  'FAILURE',
  'INACTIVE',
] as const;
export const deploymentStatusSchema = z.enum(DEPLOYMENT_STATUSES);
export type DeploymentStatus = z.infer<typeof deploymentStatusSchema>;

export const DEPLOYMENT_RELATIONS = ['SUSPECTED', 'CONFIRMED'] as const;
export const deploymentRelationSchema = z.enum(DEPLOYMENT_RELATIONS);
export type DeploymentRelation = z.infer<typeof deploymentRelationSchema>;

/** `owner/repo`, using the characters GitHub allows. */
export const repoFullNameSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/, 'must look like owner/repo');

export const createGitHubIntegrationSchema = z.object({
  repoFullName: repoFullNameSchema,
  projectId: z.uuid(),
  /** Deployments are attached to this service; when omitted they belong to the project only. */
  serviceId: z.uuid().nullish(),
});
export type CreateGitHubIntegrationInput = z.infer<typeof createGitHubIntegrationSchema>;

export const linkDeploymentSchema = z.object({
  deploymentId: z.uuid(),
  relation: deploymentRelationSchema.default('SUSPECTED'),
});
export type LinkDeploymentInput = z.infer<typeof linkDeploymentSchema>;

export interface GitHubIntegrationDto {
  id: string;
  repoFullName: string;
  projectId: string;
  serviceId: string | null;
  status: 'ACTIVE' | 'DISABLED';
  /** Path (not host) of the endpoint GitHub should deliver to. */
  webhookPath: string;
  lastEventAt: string | null;
  createdAt: string;
}

/** Returned once, when the integration is created: the only time the secret is ever shown. */
export interface CreatedGitHubIntegrationDto extends GitHubIntegrationDto {
  webhookSecret: string;
}

export interface DeploymentDto {
  id: string;
  projectId: string;
  serviceId: string | null;
  repoFullName: string;
  environment: string;
  ref: string;
  commitSha: string;
  status: DeploymentStatus;
  author: string | null;
  description: string | null;
  startedAt: string;
  deployedAt: string | null;
}

export interface IncidentDeploymentDto {
  deployment: DeploymentDto;
  relation: DeploymentRelation;
  linkedById: string | null;
  linkedAt: string;
}

export interface IncidentDeploymentsDto {
  linked: IncidentDeploymentDto[];
  /** Successful deployments to the same service shortly before the incident began, not yet linked. */
  suggested: DeploymentDto[];
}

/**
 * The subset of GitHub's `deployment_status` event NEXUS relies on. Unknown fields are ignored, and
 * anything missing here makes the event unprocessable rather than half-recorded.
 */
export const deploymentStatusEventSchema = z.object({
  deployment_status: z.object({
    state: z.string(),
    created_at: z.iso.datetime({ offset: true }),
    description: z.string().nullish(),
  }),
  deployment: z.object({
    id: z.union([z.number().int(), z.string().min(1)]),
    sha: z.string().regex(/^[0-9a-f]{7,64}$/i),
    ref: z.string().min(1),
    environment: z.string().min(1),
    created_at: z.iso.datetime({ offset: true }),
    creator: z.object({ login: z.string() }).nullish(),
  }),
  repository: z.object({ full_name: repoFullNameSchema }),
});

const STATE_TO_STATUS: Record<string, DeploymentStatus> = {
  queued: 'PENDING',
  pending: 'PENDING',
  in_progress: 'IN_PROGRESS',
  success: 'SUCCESS',
  failure: 'FAILURE',
  error: 'FAILURE',
  inactive: 'INACTIVE',
};

export interface NormalisedDeployment {
  externalId: string;
  repoFullName: string;
  environment: string;
  ref: string;
  commitSha: string;
  status: DeploymentStatus;
  author: string | null;
  description: string | null;
  startedAt: Date;
  /** When this status was reported; used to ignore a stale event that arrives out of order. */
  statusAt: Date;
}

export type NormaliseResult =
  { ok: true; deployment: NormalisedDeployment } | { ok: false; reason: string };

const clip = (value: string | null | undefined, max: number): string | null =>
  value ? value.slice(0, max) : null;

/** Turns a raw `deployment_status` payload into a deployment, or explains why it cannot be. */
export function normaliseDeploymentStatus(payload: unknown): NormaliseResult {
  const parsed = deploymentStatusEventSchema.safeParse(payload);
  if (!parsed.success) {
    return { ok: false, reason: 'payload is not a valid deployment_status event' };
  }
  const { deployment, deployment_status: status, repository } = parsed.data;
  const mapped = STATE_TO_STATUS[status.state];
  if (!mapped) {
    return { ok: false, reason: `unsupported deployment state "${status.state.slice(0, 40)}"` };
  }
  return {
    ok: true,
    deployment: {
      externalId: String(deployment.id),
      repoFullName: repository.full_name,
      environment: deployment.environment.slice(0, 100),
      ref: deployment.ref.slice(0, 250),
      commitSha: deployment.sha.toLowerCase(),
      status: mapped,
      author: clip(deployment.creator?.login, 100),
      description: clip(status.description, 500),
      startedAt: new Date(deployment.created_at),
      statusAt: new Date(status.created_at),
    },
  };
}

/** The webhook events NEXUS acts on; every other event type is acknowledged and ignored. */
export const HANDLED_GITHUB_EVENTS = ['ping', 'deployment_status'] as const;
export const isHandledGitHubEvent = (event: string): boolean =>
  (HANDLED_GITHUB_EVENTS as readonly string[]).includes(event);

/** Payload of the `webhook-processing` job: only ids, never the webhook body. */
export const webhookProcessingPayloadSchema = z.object({
  webhookEventId: z.uuid(),
  organizationId: z.uuid(),
});
export type WebhookProcessingPayload = z.infer<typeof webhookProcessingPayloadSchema>;
