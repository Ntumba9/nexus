import {
  AI_LIMITS,
  SOURCE_PREFIX,
  redactSecrets,
  type ContextSource,
  type IncidentHeader,
  type SourceKind,
} from '@nexus/shared';
import type { PrismaClient } from '@prisma/client';
import type { EmbeddingProvider } from '../knowledge/embeddings';
import { retrieveKnowledge } from '../knowledge/retrieve';

export interface AssembledContext {
  incident: IncidentHeader;
  sources: ContextSource[];
  /** True when material was left out to stay within the budget. */
  truncated: boolean;
}

/** How many of each kind are considered before the overall budget is applied. */
const CAPS = { events: 30, monitoring: 24, deployments: 8, previous: 5, knowledge: 4 } as const;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** Text that came from a person or a third party: no secrets, no control characters, bounded. */
function clean(text: string, max: number): string {
  const flat = redactSecrets(text)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
    .trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

const iso = (date: Date | null | undefined): string | null => (date ? date.toISOString() : null);
const minutesBetween = (later: Date, earlier: Date) =>
  Math.round(((later.getTime() - earlier.getTime()) / 60_000) * 10) / 10;

type Candidate = Omit<ContextSource, 'label'>;

/** What an incident timeline event says, in one plain sentence. */
export function describeTimelineEvent(type: string, data: unknown): string {
  const d = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
  const s = (key: string) => (typeof d[key] === 'string' ? (d[key] as string) : null);
  switch (type) {
    case 'CREATED':
      return 'opened this incident';
    case 'STATUS_CHANGED':
      return `changed status from ${s('from') ?? '?'} to ${s('to') ?? '?'}`;
    case 'SEVERITY_CHANGED':
      return `changed severity from ${s('from') ?? '?'} to ${s('to') ?? '?'}`;
    case 'ASSIGNED':
      return `assigned ${s('name') ?? 'a member'}`;
    case 'UNASSIGNED':
      return `unassigned ${s('name') ?? 'a member'}`;
    case 'UPDATED':
      return Array.isArray(d.fields) ? `updated ${d.fields.join(', ')}` : 'updated the incident';
    case 'COMMENT_ADDED':
      return `commented: “${s('body') ?? ''}”`;
    case 'MONITORING_SIGNAL':
      return `monitoring: ${s('kind') ?? 'change'}${s('checkName') ? ` (${s('checkName')})` : ''}`;
    case 'DEPLOYMENT_LINKED':
      return `linked a deployment as ${(s('relation') ?? 'suspected').toLowerCase()}`;
    case 'AUTOMATION_EXECUTED':
      return `an automation rule ran${s('ruleName') ? `: ${s('ruleName')}` : ''}`;
    default:
      return type.toLowerCase().replace(/_/g, ' ');
  }
}

/**
 * Gather what is known about an incident, for an analysis to read. Everything is scoped by
 * `organizationId` (the incident is looked up WITH it, and so is every other query), bounded in
 * count and size, redacted, and labelled so an answer can cite it. Returns null if the incident is
 * not in that organization.
 */
export async function assembleIncidentContext(
  prisma: PrismaClient,
  options: {
    organizationId: string;
    incidentId: string;
    /** Used only to retrieve knowledge; without one, keyword retrieval still runs. */
    embeddings?: EmbeddingProvider | null;
  },
): Promise<AssembledContext | null> {
  const { organizationId, incidentId } = options;

  const incident = await prisma.incident.findFirst({
    where: { id: incidentId, organizationId },
    select: {
      number: true,
      title: true,
      description: true,
      severity: true,
      status: true,
      createdAt: true,
      serviceId: true,
      service: { select: { name: true, environment: true, healthStatus: true } },
      tags: { select: { tag: true } },
    },
  });
  if (!incident) return null;

  const onset = incident.createdAt;
  const header: IncidentHeader = {
    number: incident.number,
    title: clean(incident.title, 200),
    description: clean(incident.description, 800),
    severity: incident.severity,
    status: incident.status,
    createdAt: onset.toISOString(),
    serviceName: incident.service ? clean(incident.service.name, 100) : null,
    serviceEnvironment: incident.service?.environment ?? null,
    serviceHealth: incident.service?.healthStatus ?? null,
    tags: incident.tags.map((t) => t.tag),
  };

  const byKind: Record<SourceKind, Candidate[]> = {
    incident_event: [],
    deployment: [],
    monitoring: [],
    previous_incident: [],
    knowledge: [],
  };

  // ---- Timeline -------------------------------------------------------------------------------
  const recent = await prisma.incidentEvent.findMany({
    where: { organizationId, incidentId, type: { not: 'AI_INVESTIGATED' } },
    orderBy: { createdAt: 'desc' },
    take: CAPS.events,
    select: {
      id: true,
      type: true,
      data: true,
      createdAt: true,
      actor: { select: { name: true } },
    },
  });
  const events = recent.reverse();
  if (!events.some((e) => e.type === 'CREATED')) {
    const created = await prisma.incidentEvent.findFirst({
      where: { organizationId, incidentId, type: 'CREATED' },
      select: {
        id: true,
        type: true,
        data: true,
        createdAt: true,
        actor: { select: { name: true } },
      },
    });
    if (created) events.unshift(created);
  }
  for (const event of events) {
    const actor = event.actor?.name ?? 'the system';
    byKind.incident_event.push({
      kind: 'incident_event',
      title: `Timeline: ${event.type.toLowerCase().replace(/_/g, ' ')}`,
      text: clean(
        `${actor} ${describeTimelineEvent(event.type, event.data)}`,
        AI_LIMITS.maxSourceChars,
      ),
      occurredAt: iso(event.createdAt),
      refId: event.id,
      facts: { actor: clean(actor, 80), type: event.type },
    });
  }

  if (incident.serviceId) {
    const serviceId = incident.serviceId;

    // ---- Deployments in the day before onset ---------------------------------------------------
    const deployments = await prisma.deployment.findMany({
      where: {
        organizationId,
        serviceId,
        startedAt: { gte: new Date(onset.getTime() - DAY_MS), lte: onset },
      },
      orderBy: { startedAt: 'desc' },
      take: CAPS.deployments,
      select: {
        id: true,
        environment: true,
        ref: true,
        commitSha: true,
        status: true,
        author: true,
        description: true,
        startedAt: true,
        deployedAt: true,
      },
    });
    for (const d of deployments.reverse()) {
      const at = d.deployedAt ?? d.startedAt;
      const sha7 = d.commitSha.slice(0, 7);
      byKind.deployment.push({
        kind: 'deployment',
        title: `Deployment ${d.environment} ${sha7}`,
        text: clean(
          `${d.environment} deployment of ${d.ref} (commit ${sha7}) by ${d.author ?? 'unknown'}: ${d.status}. ` +
            `Started ${d.startedAt.toISOString()}${d.deployedAt ? `, succeeded ${d.deployedAt.toISOString()}` : ''}.` +
            `${d.description ? ` Note: ${d.description}` : ''}`,
          AI_LIMITS.maxSourceChars,
        ),
        occurredAt: iso(at),
        refId: d.id,
        facts: {
          status: d.status,
          minutesBeforeOnset: minutesBetween(onset, at),
          environment: clean(d.environment, 40),
          ref: clean(d.ref, 80),
          sha7,
        },
      });
    }

    // ---- Recent health-check results -----------------------------------------------------------
    const checks = await prisma.monitoringCheck.findMany({
      where: { organizationId, serviceId },
      select: { id: true, name: true },
    });
    if (checks.length > 0) {
      const names = new Map(checks.map((c) => [c.id, c.name]));
      const results = await prisma.monitoringResult.findMany({
        where: {
          organizationId,
          checkId: { in: checks.map((c) => c.id) },
          checkedAt: { gte: new Date(onset.getTime() - 2 * HOUR_MS) },
        },
        orderBy: { checkedAt: 'desc' },
        take: CAPS.monitoring,
        select: {
          id: true,
          checkId: true,
          status: true,
          statusCode: true,
          responseTimeMs: true,
          failureReason: true,
          checkedAt: true,
        },
      });
      for (const r of results.reverse()) {
        const name = clean(names.get(r.checkId) ?? 'check', 80);
        byKind.monitoring.push({
          kind: 'monitoring',
          title: `Health check “${name}”`,
          text: clean(
            `${name}: ${r.status}${r.statusCode ? ` (HTTP ${r.statusCode})` : ''}` +
              `${r.responseTimeMs !== null ? `, ${r.responseTimeMs} ms` : ''}` +
              `${r.failureReason ? `, reason: ${r.failureReason}` : ''} at ${r.checkedAt.toISOString()}.`,
            AI_LIMITS.maxSourceChars,
          ),
          occurredAt: iso(r.checkedAt),
          refId: r.id,
          facts: { status: r.status, failureReason: r.failureReason },
        });
      }
    }

    // ---- Earlier incidents on the same service ---------------------------------------------------
    const previous = await prisma.incident.findMany({
      where: { organizationId, serviceId, id: { not: incidentId }, createdAt: { lt: onset } },
      orderBy: { createdAt: 'desc' },
      take: CAPS.previous,
      select: {
        id: true,
        number: true,
        title: true,
        description: true,
        severity: true,
        status: true,
        createdAt: true,
        resolvedAt: true,
      },
    });
    for (const p of previous) {
      byKind.previous_incident.push({
        kind: 'previous_incident',
        title: `INC-${p.number} ${clean(p.title, 120)}`,
        text: clean(
          `INC-${p.number} “${p.title}”: ${p.severity}, ${p.status}. Opened ${p.createdAt.toISOString()}` +
            `${p.resolvedAt ? `, resolved ${p.resolvedAt.toISOString()}` : ''}.` +
            `${p.description ? ` ${p.description}` : ''}`,
          AI_LIMITS.maxSourceChars,
        ),
        occurredAt: iso(p.createdAt),
        refId: p.id,
        facts: {
          number: p.number,
          severity: p.severity,
          status: p.status,
          daysAgo: Math.round(((onset.getTime() - p.createdAt.getTime()) / DAY_MS) * 10) / 10,
        },
      });
    }
  }

  // ---- Runbooks ---------------------------------------------------------------------------------
  try {
    const query = [
      header.title,
      header.serviceName ?? '',
      ...header.tags,
      header.description.slice(0, 300),
    ]
      .filter(Boolean)
      .join(' ');
    const { hits } = await retrieveKnowledge(prisma, {
      organizationId,
      query,
      limit: CAPS.knowledge,
      provider: options.embeddings ?? null,
    });
    for (const hit of hits) {
      byKind.knowledge.push({
        kind: 'knowledge',
        title: clean(hit.title, 120),
        text: clean(`${hit.heading}\n${hit.content}`, AI_LIMITS.maxSourceChars),
        occurredAt: null,
        refId: hit.documentId,
        facts: { title: clean(hit.title, 120) },
      });
    }
  } catch {
    // Knowledge is a bonus. An analysis without runbooks is still worth having.
  }

  // ---- Budget -------------------------------------------------------------------------------------
  const size = () =>
    Object.values(byKind).reduce(
      (sum, list) => sum + list.reduce((n, c) => n + c.title.length + c.text.length, 0),
      0,
    );
  let truncated = false;
  // What to give up first when over budget, and which end of the list to cut.
  const sacrifice: { kind: SourceKind; from: 'start' | 'end'; keep: number }[] = [
    { kind: 'previous_incident', from: 'end', keep: 0 },
    { kind: 'monitoring', from: 'start', keep: 4 },
    { kind: 'knowledge', from: 'end', keep: 1 },
    { kind: 'incident_event', from: 'start', keep: 5 },
    { kind: 'deployment', from: 'start', keep: 2 },
  ];
  outer: while (size() > AI_LIMITS.maxContextChars) {
    for (const step of sacrifice) {
      const list = byKind[step.kind];
      if (list.length > step.keep) {
        // Never drop the incident's own first event (how it was opened).
        if (step.from === 'start') list.splice(step.kind === 'incident_event' ? 1 : 0, 1);
        else list.pop();
        truncated = true;
        continue outer;
      }
    }
    break; // nothing left that may be dropped
  }

  // ---- Labels ---------------------------------------------------------------------------------------
  const order: SourceKind[] = [
    'incident_event',
    'deployment',
    'monitoring',
    'previous_incident',
    'knowledge',
  ];
  const sources: ContextSource[] = order.flatMap((kind) =>
    byKind[kind].map((candidate, i) => ({
      ...candidate,
      label: `${SOURCE_PREFIX[kind]}-${i + 1}`,
    })),
  );
  return { incident: header, sources, truncated };
}
