import { createIncidentRecord, writeAuditLog } from '@nexus/database';
import { AUTOMATION_LIMITS, renderTemplate, type CreateIncidentAction } from '@nexus/shared';
import type { ActionContext, ActionOutcome } from './notify';

/** The label under which automation appears in the audit log. */
export const AUTOMATION_ACTOR_LABEL = 'NEXUS automation';

/**
 * The `create_incident` action. The incident is opened by the automation itself: source AUTOMATION,
 * no human creator, and the timeline says AUTOMATION did it.
 *
 * Two safeguards matter here:
 *  - Idempotent. The execution and action are stamped on the incident's CREATED event, and looked for
 *    (under a lock) before creating, so a retry after a crash never opens a second incident.
 *  - No chains. The events this produces carry the execution id, and the dispatcher never runs
 *    automation for such events, so an automation cannot open incidents that trigger more automation.
 */
export async function runCreateIncident(
  ctx: ActionContext,
  action: CreateIncidentAction,
): Promise<ActionOutcome> {
  const title = renderTemplate(action.title, ctx.facts, {
    singleLine: true,
    maxLength: AUTOMATION_LIMITS.titleMax,
  });
  const description = renderTemplate(action.description, ctx.facts, {
    maxLength: AUTOMATION_LIMITS.bodyMax,
  });
  if (!title) return { status: 'FAILED', detail: 'the incident title rendered empty' };

  const eventServiceId =
    action.attachEventService && typeof ctx.facts.serviceId === 'string'
      ? ctx.facts.serviceId
      : null;

  return ctx.prisma.$transaction(async (tx) => {
    // Serialise attempts for this exact action, then look for an incident an earlier attempt made.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${ctx.executionId}:${ctx.actionIndex}`}))`;
    const existing = await tx.incidentEvent.findFirst({
      where: {
        organizationId: ctx.organizationId,
        type: 'CREATED',
        AND: [
          { data: { path: ['executionId'], equals: ctx.executionId } },
          { data: { path: ['actionIndex'], equals: ctx.actionIndex } },
        ],
      },
      select: { data: true },
    });
    if (existing) {
      const number = (existing.data as { number?: number }).number;
      return {
        status: 'SUCCEEDED' as const,
        detail: `incident INC-${number ?? '?'} was already opened`,
      };
    }

    // Only a service that really belongs to this organization is attached.
    const service = eventServiceId
      ? await tx.service.findFirst({
          where: { id: eventServiceId, organizationId: ctx.organizationId, archivedAt: null },
          select: { id: true },
        })
      : null;

    const incident = await createIncidentRecord(tx, {
      organizationId: ctx.organizationId,
      title,
      description,
      severity: action.severity,
      serviceId: service?.id ?? null,
      source: 'AUTOMATION',
      createdById: null,
      actor: { type: 'AUTOMATION', id: null },
      causedByExecutionId: ctx.executionId,
      eventData: { executionId: ctx.executionId, actionIndex: ctx.actionIndex, rule: ctx.ruleName },
    });
    await writeAuditLog(tx, {
      organizationId: ctx.organizationId,
      actor: { type: 'AUTOMATION', id: null, label: AUTOMATION_ACTOR_LABEL },
      action: 'automation.incident.created',
      resourceType: 'incident',
      resourceId: incident.id,
      metadata: {
        rule: ctx.ruleName,
        executionId: ctx.executionId,
        trigger: ctx.trigger,
        incidentNumber: incident.number,
        severity: action.severity,
      },
    });
    return { status: 'SUCCEEDED' as const, detail: `opened incident INC-${incident.number}` };
  });
}
