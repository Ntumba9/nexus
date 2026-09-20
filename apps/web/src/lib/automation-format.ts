import {
  CHANNEL_LABEL,
  OPERATOR_LABEL,
  SEVERITY_LABEL,
  TRIGGER_FIELDS,
  type AuditAction,
  type AuditLogDto,
  type AutomationAction,
  type AutomationTrigger,
  type Condition,
  type ExecutionStatus,
  type IncidentSeverity,
  type Recipients,
  type Role,
  type SkipReason,
} from '@nexus/shared';
import { HEALTH_LABEL, STATUS_LABEL } from './incident-format';

export const EXECUTION_STATUS_LABEL: Record<ExecutionStatus, string> = {
  PENDING: 'Queued',
  RUNNING: 'Running',
  SUCCEEDED: 'Succeeded',
  PARTIAL: 'Partly succeeded',
  FAILED: 'Failed',
  SKIPPED: 'Skipped',
};

export const EXECUTION_STATUS_STYLE: Record<ExecutionStatus, string> = {
  PENDING: 'bg-white/5 text-muted ring-white/10',
  RUNNING: 'bg-accent/10 text-accent ring-accent/25',
  SUCCEEDED: 'bg-success/10 text-success ring-success/25',
  PARTIAL: 'bg-warning/10 text-warning ring-warning/25',
  FAILED: 'bg-danger/10 text-danger ring-danger/25',
  SKIPPED: 'bg-white/5 text-muted ring-white/10',
};

export const SKIP_REASON_LABEL: Record<SkipReason, string> = {
  cooldown: 'It already ran recently for the same item (cooldown)',
  rate_limited: 'The rule reached its hourly limit',
  rule_disabled: 'The rule was turned off before it ran',
};

const ROLE_LABEL: Record<Role, string> = {
  OWNER: 'owners',
  ADMIN: 'admins',
  DEVELOPER: 'developers',
  SUPPORT: 'support',
  VIEWER: 'viewers',
};

/** Human wording for a fact value: "SEV-1" rather than "SEV1", "Down" rather than "DOWN". */
export function factValueLabel(value: unknown): string {
  const text = String(value);
  if (text in SEVERITY_LABEL) return SEVERITY_LABEL[text as IncidentSeverity];
  if (text in STATUS_LABEL) return (STATUS_LABEL as Record<string, string>)[text]!;
  if (text in HEALTH_LABEL) return (HEALTH_LABEL as Record<string, string>)[text]!;
  return text;
}

export function fieldLabel(trigger: AutomationTrigger, name: string): string {
  return TRIGGER_FIELDS[trigger].find((field) => field.name === name)?.label ?? name;
}

/** "Severity is one of SEV-1, SEV-2". */
export function describeCondition(trigger: AutomationTrigger, condition: Condition): string {
  const values = (Array.isArray(condition.value) ? condition.value : [condition.value]).map(
    factValueLabel,
  );
  return `${fieldLabel(trigger, condition.field)} ${OPERATOR_LABEL[condition.operator]} ${values.join(', ')}`;
}

export function describeRecipients(recipients: Recipients): string {
  const parts = [
    ...recipients.roles.map((role) => ROLE_LABEL[role]),
    recipients.assignee ? 'the person assigned' : null,
    recipients.incidentAssignees ? 'everyone on the incident' : null,
    recipients.userIds.length > 0
      ? `${recipients.userIds.length} named ${recipients.userIds.length === 1 ? 'person' : 'people'}`
      : null,
  ].filter(Boolean);
  return parts.join(', ');
}

/** One line for an action, for lists: "Notify admins, owners (in-app, email)". */
export function describeAction(
  action: AutomationAction,
  webhookNames: ReadonlyMap<string, string> = new Map(),
): string {
  switch (action.type) {
    case 'notify':
      return `Notify ${describeRecipients(action.recipients)} (${action.channels
        .map((channel) => CHANNEL_LABEL[channel].toLowerCase())
        .join(', ')})`;
    case 'webhook': {
      const name = webhookNames.get(action.destinationId);
      return name ? `Call the webhook “${name}”` : 'Call a webhook (no longer available)';
    }
    case 'create_incident':
      return `Open a ${SEVERITY_LABEL[action.severity]} incident`;
  }
}

const AUDIT_VERB: Record<AuditAction, string> = {
  'automation.rule.created': 'created the automation rule',
  'automation.rule.updated': 'changed the automation rule',
  'automation.rule.deleted': 'deleted the automation rule',
  'automation.rule.enabled': 'turned on the automation rule',
  'automation.rule.disabled': 'turned off the automation rule',
  'automation.incident.created': 'opened an incident (automation)',
  'outbound_webhook.created': 'added the outbound webhook',
  'outbound_webhook.disabled': 'disabled the outbound webhook',
  'integration.github.created': 'connected the GitHub repository',
  'integration.github.disabled': 'disconnected the GitHub repository',
  'knowledge.document.created': 'created the document',
  'knowledge.document.updated': 'edited the document',
  'knowledge.document.deleted': 'deleted the document',
};

/** "created the automation rule “Critical incident alert”". */
export function describeAudit(entry: Pick<AuditLogDto, 'action' | 'metadata'>): string {
  const verb = AUDIT_VERB[entry.action as AuditAction] ?? entry.action;
  const meta = entry.metadata;
  const subject =
    typeof meta.name === 'string'
      ? meta.name
      : typeof meta.title === 'string'
        ? meta.title
        : typeof meta.repository === 'string'
          ? meta.repository
          : typeof meta.incidentNumber === 'number'
            ? `INC-${meta.incidentNumber}`
            : null;
  return subject ? `${verb} “${subject}”` : verb;
}
