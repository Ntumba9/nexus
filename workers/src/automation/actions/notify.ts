import type { PrismaClient } from '@nexus/database';
import {
  AUTOMATION_LIMITS,
  isIncidentTrigger,
  renderTemplate,
  type AutomationTrigger,
  type Facts,
  type NotifyAction,
} from '@nexus/shared';
import type { Logger } from '../../logger';
import { EmailError, type EmailSender } from '../email';

export interface ActionContext {
  prisma: PrismaClient;
  logger: Logger;
  email: EmailSender;
  /** Origin of the web app, used to build absolute links in emails. */
  webOrigin: string;
  organizationId: string;
  executionId: string;
  ruleName: string;
  trigger: AutomationTrigger;
  facts: Facts;
  actionIndex: number;
}

export interface ActionOutcome {
  status: 'SUCCEEDED' | 'PARTIAL' | 'FAILED' | 'SKIPPED';
  /** Short and human-readable; never contains a secret, an address or a message body. */
  detail: string;
  /** True when trying again could succeed (a network hiccup), false for a permanent problem. */
  retryable?: boolean;
}

/** A hard ceiling: a role that matches a huge organization must not become an unbounded fan-out. */
export const MAX_NOTIFICATION_RECIPIENTS = 200;

const str = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null;

/** In-app path for what the notification is about. Built from ids we hold, never from user input. */
export function linkFor(organizationId: string, trigger: AutomationTrigger, facts: Facts): string {
  const base = `/orgs/${organizationId}`;
  const incidentId = str(facts.incidentId);
  const serviceId = str(facts.serviceId);
  if (isIncidentTrigger(trigger) && incidentId) return `${base}/incidents/${incidentId}`;
  if (serviceId) return `${base}/services/${serviceId}`;
  return trigger.startsWith('deployment.') ? `${base}/deployments` : base;
}

interface Recipient {
  userId: string;
  email: string;
}

/**
 * Who should be told. Membership is checked NOW, at run time: a rule saved when someone was a member
 * must not keep notifying them after they were removed (the composite foreign key on Notification
 * would refuse the row anyway; this makes the outcome clean instead of an error).
 */
async function resolveRecipients(
  ctx: ActionContext,
  action: NotifyAction,
): Promise<{ recipients: Recipient[]; truncated: boolean }> {
  const { prisma, organizationId, facts } = ctx;
  const wanted = new Set<string>(action.recipients.userIds);

  const assignee = str(facts.assigneeUserId);
  if (action.recipients.assignee && assignee) wanted.add(assignee);

  const incidentId = str(facts.incidentId);
  if (action.recipients.incidentAssignees && incidentId) {
    const assignments = await prisma.incidentAssignment.findMany({
      where: { organizationId, incidentId, unassignedAt: null },
      select: { userId: true },
    });
    for (const assignment of assignments) wanted.add(assignment.userId);
  }

  const or = [
    ...(action.recipients.roles.length > 0 ? [{ role: { in: action.recipients.roles } }] : []),
    ...(wanted.size > 0 ? [{ userId: { in: [...wanted] } }] : []),
  ];
  if (or.length === 0) return { recipients: [], truncated: false };

  const members = await prisma.organizationMember.findMany({
    where: { organizationId, OR: or, user: { disabledAt: null } },
    select: { userId: true, user: { select: { email: true } } },
    orderBy: { createdAt: 'asc' },
    take: MAX_NOTIFICATION_RECIPIENTS + 1,
  });
  const truncated = members.length > MAX_NOTIFICATION_RECIPIENTS;
  return {
    recipients: members
      .slice(0, MAX_NOTIFICATION_RECIPIENTS)
      .map((member) => ({ userId: member.userId, email: member.user.email })),
    truncated,
  };
}

const shortError = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').slice(0, 150);

/**
 * Notify people. One `Notification` row per recipient is the delivery record: it is what the inbox
 * shows and what remembers whether an email went out. It is unique per (execution, action,
 * recipient), so a retried job finds the rows it already made and only sends the emails that have
 * not been sent yet. A retry never duplicates a notification or an email.
 */
export async function runNotify(ctx: ActionContext, action: NotifyAction): Promise<ActionOutcome> {
  const { prisma, organizationId, executionId, actionIndex } = ctx;
  const wantsInApp = action.channels.includes('in_app');
  const wantsEmail = action.channels.includes('email');

  const { recipients, truncated } = await resolveRecipients(ctx, action);
  if (recipients.length === 0) {
    return { status: 'SKIPPED', detail: 'no eligible recipients (are they still members?)' };
  }

  const title = renderTemplate(action.title, ctx.facts, {
    singleLine: true,
    maxLength: AUTOMATION_LIMITS.titleMax,
  });
  const body = renderTemplate(action.body, ctx.facts, { maxLength: AUTOMATION_LIMITS.bodyMax });
  const link = linkFor(organizationId, ctx.trigger, ctx.facts);

  // Idempotent: rows that already exist (an earlier attempt) are left exactly as they are.
  await prisma.notification.createMany({
    data: recipients.map((recipient) => ({
      organizationId,
      userId: recipient.userId,
      type: ctx.trigger,
      title: title || ctx.ruleName.slice(0, AUTOMATION_LIMITS.titleMax),
      body,
      link,
      inApp: wantsInApp,
      emailStatus: wantsEmail ? 'PENDING' : 'NONE',
      executionId,
      actionIndex,
    })),
    skipDuplicates: true,
  });

  let retryable = false;
  if (wantsEmail) {
    const pending = await prisma.notification.findMany({
      where: {
        organizationId,
        executionId,
        actionIndex,
        userId: { in: recipients.map((r) => r.userId) },
        emailStatus: { in: ['PENDING', 'FAILED'] },
      },
      select: { id: true, userId: true },
    });
    const addressOf = new Map(recipients.map((r) => [r.userId, r.email]));
    const text = [body, `${ctx.webOrigin.replace(/\/+$/, '')}${link}`].filter(Boolean).join('\n\n');

    for (const row of pending) {
      const to = addressOf.get(row.userId);
      if (!to) continue;
      try {
        await ctx.email.send({ to, subject: `[NEXUS] ${title}`.slice(0, 200), text });
        await prisma.notification.update({
          where: { id: row.id },
          data: { emailStatus: 'SENT', emailError: null },
          select: { id: true },
        });
      } catch (error) {
        if (!(error instanceof EmailError) || error.retryable) retryable = true;
        await prisma.notification.update({
          where: { id: row.id },
          data: { emailStatus: 'FAILED', emailError: shortError(error) },
          select: { id: true },
        });
        ctx.logger.warn('email delivery failed', { executionId, error: shortError(error) });
      }
    }
  }

  // Report the final state from the delivery records, not just what this attempt did.
  const countEmails = (emailStatus: 'SENT' | 'FAILED') =>
    wantsEmail
      ? prisma.notification.count({
          where: { organizationId, executionId, actionIndex, emailStatus },
        })
      : Promise.resolve(0);
  const emailed = await countEmails('SENT');
  const failed = await countEmails('FAILED');

  const parts = [
    wantsInApp ? `${recipients.length} in-app` : null,
    wantsEmail ? `${emailed} emailed` : null,
    failed > 0 ? `${failed} email failed` : null,
    truncated ? `limited to the first ${MAX_NOTIFICATION_RECIPIENTS} recipients` : null,
  ].filter(Boolean);
  if (failed === 0) return { status: 'SUCCEEDED', detail: `notified: ${parts.join(', ')}` };
  // Something went out (an in-app notification, or another recipient's email) but not everything.
  const deliveredSomething = wantsInApp || emailed > 0;
  return {
    status: deliveredSomething ? 'PARTIAL' : 'FAILED',
    detail: `notified: ${parts.join(', ')}`,
    retryable,
  };
}
