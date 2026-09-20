import { z } from 'zod';
import type { AutomationTrigger } from './automation';
import type { Permission } from './permissions';

/**
 * Real-time updates (ADR-014). A message is only a *signal* that something of a given kind changed
 * in an organisation. It carries no record data: the browser reacts by refetching through the REST
 * API, where authorization already lives. So the stream can never reveal more than a refetch would.
 */

export const REALTIME_TOPICS = [
  'incidents',
  'projects',
  'services',
  'monitoring',
  'deployments',
  'integrations',
  'automation',
  'notifications',
  'members',
  'organization',
  'knowledge',
] as const;
export const realtimeTopicSchema = z.enum(REALTIME_TOPICS);
export type RealtimeTopic = z.infer<typeof realtimeTopicSchema>;

/**
 * The permission a member needs to be told about a topic. It mirrors what the matching REST reads
 * require, so the stream does not even hint at activity in areas the member cannot read.
 */
export const TOPIC_PERMISSION: Readonly<Record<RealtimeTopic, Permission>> = {
  incidents: 'incidents.read',
  projects: 'projects.read',
  services: 'projects.read',
  monitoring: 'projects.read',
  deployments: 'projects.read',
  integrations: 'integrations.manage',
  automation: 'automation.manage',
  notifications: 'organization.read',
  members: 'users.read',
  organization: 'organization.read',
  knowledge: 'knowledge.read',
};

export const realtimeMessageSchema = z.object({
  topic: realtimeTopicSchema,
  /** Set for notifications: only that user's streams receive the message. */
  userId: z.uuid().optional(),
});
export type RealtimeMessage = z.infer<typeof realtimeMessageSchema>;

/** One Redis channel per organisation. */
export const REALTIME_CHANNEL_PREFIX = 'nexus:rt:';
export const realtimeChannel = (organizationId: string): string =>
  `${REALTIME_CHANNEL_PREFIX}${organizationId}`;

/** Pattern subscription covering every organisation. */
export const REALTIME_CHANNEL_PATTERN = `${REALTIME_CHANNEL_PREFIX}*`;

/** The organisation id out of a channel name, or null if it is not one of ours. */
export function organizationOfChannel(channel: string): string | null {
  if (!channel.startsWith(REALTIME_CHANNEL_PREFIX)) return null;
  const id = channel.slice(REALTIME_CHANNEL_PREFIX.length);
  return z.uuid().safeParse(id).success ? id : null;
}

export function decodeRealtimeMessage(raw: string): RealtimeMessage | null {
  try {
    const parsed = realtimeMessageSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** The part of a Redis client this needs; lets tests pass a fake. */
export interface RealtimePublisher {
  publish(channel: string, message: string): Promise<unknown>;
}

/**
 * Best-effort: a real-time signal must never fail the work that caused it. If Redis is down the
 * change is still saved, and clients catch up through their fallback polling and on reconnect.
 */
export async function publishRealtime(
  publisher: RealtimePublisher,
  organizationId: string,
  messages: readonly RealtimeMessage[],
): Promise<boolean> {
  if (messages.length === 0) return true;
  try {
    await Promise.all(
      messages.map((message) =>
        publisher.publish(realtimeChannel(organizationId), JSON.stringify(message)),
      ),
    );
    return true;
  } catch {
    return false;
  }
}

/** What a domain event (the automation outbox) means for the browser. */
export function topicsForDomainEvent(type: AutomationTrigger | string): RealtimeTopic[] {
  if (type.startsWith('incident.')) return ['incidents'];
  if (type === 'service.health_changed') return ['services', 'monitoring'];
  if (type.startsWith('deployment.')) return ['deployments'];
  return [];
}

const SEGMENT_TOPICS: Readonly<Record<string, RealtimeTopic>> = {
  incidents: 'incidents',
  projects: 'projects',
  services: 'services',
  checks: 'monitoring',
  deployments: 'deployments',
  integrations: 'integrations',
  automation: 'automation',
  'outbound-webhooks': 'automation',
  notifications: 'notifications',
  members: 'members',
  knowledge: 'knowledge',
};

/**
 * Which topics a successful REST mutation touched, from its path below `/orgs/:orgId/`
 * (for example `incidents/<id>/transitions`). Unknown paths signal nothing.
 */
export function topicsForMutation(pathBelowOrg: string): RealtimeTopic[] {
  const segments = pathBelowOrg.split('/').filter(Boolean);
  if (segments.length === 0) return ['organization'];
  const [first, , third] = segments;
  const topics = new Set<RealtimeTopic>();
  const main = first ? SEGMENT_TOPICS[first] : undefined;
  if (main) topics.add(main);
  // Nested resources change a second thing too.
  if (first === 'services' && third === 'checks') topics.add('monitoring');
  if (first === 'incidents' && third === 'deployments') topics.add('deployments');
  if (first === 'checks') topics.add('services');
  return [...topics];
}
