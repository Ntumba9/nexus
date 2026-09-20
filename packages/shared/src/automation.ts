import { z } from 'zod';
import {
  INCIDENT_SEVERITIES,
  INCIDENT_SOURCES,
  INCIDENT_STATUSES,
  incidentSeveritySchema,
} from './incidents';
import { roleSchema } from './permissions';
import { SERVICE_ENVIRONMENTS, SERVICE_HEALTH } from './projects';

/**
 * Automation vocabulary, defined ONCE. The API validates rules with it, the worker evaluates them
 * with it and the web app builds its forms from it, so the three can never disagree about what a
 * trigger, a condition or an action is.
 */

// ---- Limits (mirrored by database CHECK constraints where the database can express them) -------

export const AUTOMATION_LIMITS = {
  maxRulesPerOrganization: 50,
  maxActionsPerRule: 5,
  maxConditionsPerRule: 10,
  maxUserRecipients: 25,
  maxWebhooksPerOrganization: 10,
  cooldownSeconds: { min: 0, max: 86_400, default: 300 },
  nameMax: 80,
  titleMax: 160,
  bodyMax: 1000,
  /** Each substituted value is cut to this length, so one huge field cannot bloat a notification. */
  placeholderValueMax: 200,
} as const;

// ---- Triggers and the facts each one carries ---------------------------------------------------

export const AUTOMATION_TRIGGERS = [
  'incident.created',
  'incident.status_changed',
  'incident.severity_changed',
  'incident.assigned',
  'service.health_changed',
  'deployment.succeeded',
  'deployment.failed',
] as const;
export const automationTriggerSchema = z.enum(AUTOMATION_TRIGGERS);
export type AutomationTrigger = z.infer<typeof automationTriggerSchema>;

export const TRIGGER_LABEL: Record<AutomationTrigger, string> = {
  'incident.created': 'An incident is opened',
  'incident.status_changed': 'An incident changes status',
  'incident.severity_changed': 'An incident changes severity',
  'incident.assigned': 'Someone is assigned to an incident',
  'service.health_changed': "A service's health changes",
  'deployment.succeeded': 'A deployment succeeds',
  'deployment.failed': 'A deployment fails',
};

/** A fact is a flat scalar. Conditions and templates can only see facts, never raw records. */
export type FactValue = string | number | boolean | null;
export type Facts = Record<string, FactValue>;

export interface FactField {
  name: string;
  label: string;
  /** `enum` fields list their legal values; the others are free text or identifiers. */
  kind: 'enum' | 'text' | 'id' | 'number';
  values?: readonly string[];
}

const f = (
  name: string,
  label: string,
  kind: FactField['kind'] = 'text',
  values?: readonly string[],
): FactField => (values ? { name, label, kind, values } : { name, label, kind });

const INCIDENT_FIELDS: FactField[] = [
  f('incidentId', 'Incident id', 'id'),
  f('number', 'Incident number', 'number'),
  f('title', 'Title'),
  f('severity', 'Severity', 'enum', INCIDENT_SEVERITIES),
  f('status', 'Status', 'enum', INCIDENT_STATUSES),
  f('source', 'Source', 'enum', INCIDENT_SOURCES),
  f('serviceId', 'Service id', 'id'),
  f('serviceName', 'Service name'),
];

const DEPLOYMENT_FIELDS: FactField[] = [
  f('deploymentId', 'Deployment id', 'id'),
  f('serviceId', 'Service id', 'id'),
  f('serviceName', 'Service name'),
  f('repoFullName', 'Repository'),
  f('environment', 'Environment'),
  f('ref', 'Ref'),
  f('commitSha', 'Commit'),
  f('commitShort', 'Short commit'),
  f('author', 'Author'),
  f('status', 'Status'),
];

/** The facts available to conditions and templates, per trigger. */
export const TRIGGER_FIELDS: Record<AutomationTrigger, readonly FactField[]> = {
  'incident.created': INCIDENT_FIELDS,
  'incident.status_changed': [
    ...INCIDENT_FIELDS,
    f('fromStatus', 'Previous status', 'enum', INCIDENT_STATUSES),
    f('toStatus', 'New status', 'enum', INCIDENT_STATUSES),
  ],
  'incident.severity_changed': [
    ...INCIDENT_FIELDS,
    f('fromSeverity', 'Previous severity', 'enum', INCIDENT_SEVERITIES),
    f('toSeverity', 'New severity', 'enum', INCIDENT_SEVERITIES),
  ],
  'incident.assigned': [
    ...INCIDENT_FIELDS,
    f('assigneeUserId', 'Assignee id', 'id'),
    f('assigneeName', 'Assignee'),
  ],
  'service.health_changed': [
    f('serviceId', 'Service id', 'id'),
    f('serviceName', 'Service name'),
    f('projectId', 'Project id', 'id'),
    f('environment', 'Environment', 'enum', SERVICE_ENVIRONMENTS),
    f('fromHealth', 'Previous health', 'enum', SERVICE_HEALTH),
    f('toHealth', 'New health', 'enum', SERVICE_HEALTH),
  ],
  'deployment.succeeded': DEPLOYMENT_FIELDS,
  'deployment.failed': DEPLOYMENT_FIELDS,
};

export const isIncidentTrigger = (trigger: AutomationTrigger): boolean =>
  trigger.startsWith('incident.');

const fieldOf = (trigger: AutomationTrigger, name: string): FactField | undefined =>
  TRIGGER_FIELDS[trigger].find((field) => field.name === name);

// ---- Conditions --------------------------------------------------------------------------------

export const CONDITION_OPERATORS = ['eq', 'neq', 'in', 'not_in'] as const;
export const OPERATOR_LABEL: Record<(typeof CONDITION_OPERATORS)[number], string> = {
  eq: 'is',
  neq: 'is not',
  in: 'is one of',
  not_in: 'is none of',
};

const scalar = z.union([z.string().max(200), z.number(), z.boolean()]);

export const conditionSchema = z.object({
  field: z.string().min(1).max(60),
  operator: z.enum(CONDITION_OPERATORS),
  value: z.union([scalar, z.array(scalar).min(1).max(20)]),
});
export type Condition = z.infer<typeof conditionSchema>;
export const conditionListSchema = z.array(conditionSchema);

/**
 * Conditions are AND-combined. A missing fact is not "equal" to anything: `eq` and `in` are false
 * for it and `neq` and `not_in` are true, so a rule never matches by accident on absent data.
 */
export function evaluateConditions(conditions: readonly Condition[], facts: Facts): boolean {
  return conditions.every((condition) => {
    const fact = factOf(facts, condition.field);
    const list = Array.isArray(condition.value) ? condition.value : [condition.value];
    const present = fact !== undefined && fact !== null;
    switch (condition.operator) {
      case 'eq':
        return present && list.length > 0 && fact === list[0];
      case 'neq':
        return !present || fact !== list[0];
      case 'in':
        return present && list.includes(fact as string | number | boolean);
      case 'not_in':
        return !present || !list.includes(fact as string | number | boolean);
    }
  });
}

// ---- Templates ---------------------------------------------------------------------------------

const PLACEHOLDER = /\{\{\s*([A-Za-z][A-Za-z0-9]*)\s*\}\}/g;

export function extractPlaceholders(template: string): string[] {
  return [...template.matchAll(PLACEHOLDER)].map((match) => match[1]!);
}

/**
 * Removes control characters (everything below 0x20 except tab, newline and carriage return, plus
 * DEL). They are never legitimate in a notification and are how header and log injection is done.
 */
function stripControl(text: string): string {
  let out = '';
  for (const char of text) {
    const code = char.codePointAt(0)!;
    if ((code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127) continue;
    out += char;
  }
  return out;
}

/** Own properties only: `constructor`, `toString` and other inherited names are not facts. */
function factOf(facts: Facts, name: string): FactValue | undefined {
  return Object.prototype.hasOwnProperty.call(facts, name) ? facts[name] : undefined;
}

/**
 * Substitutes `{{fact}}` placeholders. This is plain text substitution and nothing else: no
 * expressions, no code, no HTML. Values come from user-controlled data (an incident title, a commit
 * author), so they are length-limited and stripped of control characters, and single-line output
 * (titles, email subjects) also has line breaks collapsed. An unknown placeholder renders as empty.
 */
export function renderTemplate(
  template: string,
  facts: Facts,
  options: { singleLine?: boolean; maxLength?: number } = {},
): string {
  const rendered = template.replace(PLACEHOLDER, (_whole, name: string) => {
    const value = factOf(facts, name);
    if (value === undefined || value === null) return '';
    return stripControl(String(value)).slice(0, AUTOMATION_LIMITS.placeholderValueMax);
  });
  const cleaned = stripControl(rendered);
  const text = options.singleLine ? cleaned.replace(/\s*[\r\n]+\s*/g, ' ').trim() : cleaned.trim();
  return options.maxLength ? text.slice(0, options.maxLength) : text;
}

// ---- Actions -----------------------------------------------------------------------------------

export const NOTIFICATION_CHANNELS = ['in_app', 'email'] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];
export const CHANNEL_LABEL: Record<NotificationChannel, string> = {
  in_app: 'In-app',
  email: 'Email',
};

export const recipientsSchema = z
  .object({
    roles: z.array(roleSchema).max(5).default([]),
    userIds: z.array(z.uuid()).max(AUTOMATION_LIMITS.maxUserRecipients).default([]),
    /** Everyone currently assigned to the incident in the event. */
    incidentAssignees: z.boolean().default(false),
    /** The person named in an `incident.assigned` event. */
    assignee: z.boolean().default(false),
  })
  .refine((r) => r.roles.length > 0 || r.userIds.length > 0 || r.incidentAssignees || r.assignee, {
    message: 'choose at least one recipient',
  });
export type Recipients = z.infer<typeof recipientsSchema>;

export const notifyActionSchema = z.object({
  type: z.literal('notify'),
  recipients: recipientsSchema,
  channels: z.array(z.enum(NOTIFICATION_CHANNELS)).min(1).max(2),
  title: z.string().trim().min(1).max(AUTOMATION_LIMITS.titleMax),
  body: z.string().trim().max(AUTOMATION_LIMITS.bodyMax).default(''),
});

export const webhookActionSchema = z.object({
  type: z.literal('webhook'),
  destinationId: z.uuid(),
});

export const createIncidentActionSchema = z.object({
  type: z.literal('create_incident'),
  title: z.string().trim().min(1).max(AUTOMATION_LIMITS.titleMax),
  description: z.string().trim().max(AUTOMATION_LIMITS.bodyMax).default(''),
  severity: incidentSeveritySchema,
  /** Attach the incident to the service named in the event, when the event has one. */
  attachEventService: z.boolean().default(true),
});

export const automationActionSchema = z.discriminatedUnion('type', [
  notifyActionSchema,
  webhookActionSchema,
  createIncidentActionSchema,
]);
export type AutomationAction = z.infer<typeof automationActionSchema>;
export const automationActionListSchema = z.array(automationActionSchema);
export type NotifyAction = z.infer<typeof notifyActionSchema>;
export type CreateIncidentAction = z.infer<typeof createIncidentActionSchema>;

export const ACTION_LABEL: Record<AutomationAction['type'], string> = {
  notify: 'Send a notification',
  webhook: 'Call a webhook',
  create_incident: 'Open an incident',
};

// ---- Rules -------------------------------------------------------------------------------------

/** The fields of a rule a person edits. Trigger-specific rules are checked in `superRefine`. */
const ruleShape = {
  name: z.string().trim().min(1).max(AUTOMATION_LIMITS.nameMax),
  trigger: automationTriggerSchema,
  conditions: z.array(conditionSchema).max(AUTOMATION_LIMITS.maxConditionsPerRule).default([]),
  actions: z.array(automationActionSchema).min(1).max(AUTOMATION_LIMITS.maxActionsPerRule),
  enabled: z.boolean().default(true),
  cooldownSeconds: z
    .number()
    .int()
    .min(AUTOMATION_LIMITS.cooldownSeconds.min)
    .max(AUTOMATION_LIMITS.cooldownSeconds.max)
    .default(AUTOMATION_LIMITS.cooldownSeconds.default),
};

interface RuleForRefinement {
  trigger: AutomationTrigger;
  conditions: Condition[];
  actions: AutomationAction[];
}

/** Everything that depends on the trigger: which facts exist, which recipients make sense. */
function refineRule(rule: RuleForRefinement, ctx: z.RefinementCtx): void {
  rule.conditions.forEach((condition, i) => {
    const field = fieldOf(rule.trigger, condition.field);
    if (!field) {
      ctx.addIssue({
        code: 'custom',
        path: ['conditions', i, 'field'],
        message: `"${condition.field}" is not available for this trigger`,
      });
      return;
    }
    const isList = Array.isArray(condition.value);
    const wantsList = condition.operator === 'in' || condition.operator === 'not_in';
    if (isList !== wantsList) {
      ctx.addIssue({
        code: 'custom',
        path: ['conditions', i, 'value'],
        message: wantsList ? 'provide a list of values' : 'provide a single value',
      });
      return;
    }
    if (field.kind === 'enum') {
      const values = (isList ? condition.value : [condition.value]) as unknown[];
      const bad = values.find((v) => typeof v !== 'string' || !field.values?.includes(v));
      if (bad !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['conditions', i, 'value'],
          message: `"${String(bad)}" is not a valid ${field.label.toLowerCase()}`,
        });
      }
    }
  });

  const known = new Set(TRIGGER_FIELDS[rule.trigger].map((field) => field.name));
  rule.actions.forEach((action, i) => {
    const templates =
      action.type === 'notify'
        ? [action.title, action.body]
        : action.type === 'create_incident'
          ? [action.title, action.description]
          : [];
    for (const name of templates.flatMap(extractPlaceholders)) {
      if (!known.has(name)) {
        ctx.addIssue({
          code: 'custom',
          path: ['actions', i],
          message: `{{${name}}} is not available for this trigger`,
        });
      }
    }
    if (action.type === 'notify') {
      if (action.recipients.incidentAssignees && !isIncidentTrigger(rule.trigger)) {
        ctx.addIssue({
          code: 'custom',
          path: ['actions', i, 'recipients'],
          message: 'incident assignees only exist for incident triggers',
        });
      }
      if (action.recipients.assignee && rule.trigger !== 'incident.assigned') {
        ctx.addIssue({
          code: 'custom',
          path: ['actions', i, 'recipients'],
          message: '"the assigned person" only exists for the assignment trigger',
        });
      }
    }
  });
}

export const createRuleSchema = z.object(ruleShape).superRefine(refineRule);
export type CreateRuleInput = z.infer<typeof createRuleSchema>;

/** Updates replace the whole definition (a rule is small), so they validate the same way. */
export const updateRuleSchema = createRuleSchema;
export type UpdateRuleInput = CreateRuleInput;

// ---- Executions --------------------------------------------------------------------------------

export const EXECUTION_STATUSES = [
  'PENDING',
  'RUNNING',
  'SUCCEEDED',
  'PARTIAL',
  'FAILED',
  'SKIPPED',
] as const;
export type ExecutionStatus = (typeof EXECUTION_STATUSES)[number];

/** Why an execution was recorded as SKIPPED instead of running. */
export const SKIP_REASONS = ['cooldown', 'rate_limited', 'rule_disabled'] as const;
export type SkipReason = (typeof SKIP_REASONS)[number];

export interface ActionResult {
  index: number;
  type: AutomationAction['type'];
  /** PARTIAL: it did some of what was asked (told everyone in-app, but an email failed). */
  status: 'SUCCEEDED' | 'PARTIAL' | 'FAILED' | 'SKIPPED';
  /** Short, human-readable, never contains a secret or a payload. */
  detail: string;
  /** Set on a failure that trying again could fix (a network hiccup), so a retry re-runs it. */
  retryable?: boolean;
}

/** How stored results are read back: a retried execution resumes from what was already recorded. */
export const actionResultListSchema = z.array(
  z.object({
    index: z.number().int(),
    type: z.enum(['notify', 'webhook', 'create_incident']),
    status: z.enum(['SUCCEEDED', 'PARTIAL', 'FAILED', 'SKIPPED']),
    detail: z.string(),
    retryable: z.boolean().optional(),
  }),
);

/** Payload of an `automation` queue job: ids only. Everything else is read from the database. */
export const automationJobPayloadSchema = z.object({
  executionId: z.uuid(),
  organizationId: z.uuid(),
});
export type AutomationJobPayload = z.infer<typeof automationJobPayloadSchema>;

// ---- Rule templates (data, not code) -----------------------------------------------------------

export interface RuleTemplate {
  id: string;
  name: string;
  description: string;
  rule: CreateRuleInput;
}

const rule = (input: z.input<typeof createRuleSchema>): CreateRuleInput =>
  createRuleSchema.parse(input);

/**
 * Starting points offered in the UI. They are ordinary rules: choosing one just pre-fills the form,
 * and the result is validated and stored exactly like a rule written from scratch.
 */
export const RULE_TEMPLATES: readonly RuleTemplate[] = [
  {
    id: 'critical-incident-alert',
    name: 'Alert admins to critical incidents',
    description:
      'When a SEV-1 or SEV-2 incident is opened, notify owners and admins in-app and by email.',
    rule: rule({
      name: 'Critical incident alert',
      trigger: 'incident.created',
      conditions: [{ field: 'severity', operator: 'in', value: ['SEV1', 'SEV2'] }],
      actions: [
        {
          type: 'notify',
          recipients: { roles: ['OWNER', 'ADMIN'] },
          channels: ['in_app', 'email'],
          title: '{{severity}} incident INC-{{number}}: {{title}}',
          body: 'A {{severity}} incident was opened on {{serviceName}}.',
        },
      ],
    }),
  },
  {
    id: 'service-down',
    name: 'Tell the team when a service goes down',
    description: 'When a service becomes DOWN, notify owners, admins and developers in-app.',
    rule: rule({
      name: 'Service down',
      trigger: 'service.health_changed',
      conditions: [{ field: 'toHealth', operator: 'eq', value: 'DOWN' }],
      actions: [
        {
          type: 'notify',
          recipients: { roles: ['OWNER', 'ADMIN', 'DEVELOPER'] },
          channels: ['in_app'],
          title: '{{serviceName}} is down',
          body: '{{serviceName}} ({{environment}}) changed from {{fromHealth}} to {{toHealth}}.',
        },
      ],
    }),
  },
  {
    id: 'service-recovered',
    name: 'Tell admins when a service recovers',
    description: 'When a service becomes HEALTHY again, notify owners and admins in-app.',
    rule: rule({
      name: 'Service recovered',
      trigger: 'service.health_changed',
      conditions: [{ field: 'toHealth', operator: 'eq', value: 'HEALTHY' }],
      actions: [
        {
          type: 'notify',
          recipients: { roles: ['OWNER', 'ADMIN'] },
          channels: ['in_app'],
          title: '{{serviceName}} recovered',
          body: '{{serviceName}} ({{environment}}) is healthy again.',
        },
      ],
    }),
  },
  {
    id: 'assigned-to-me',
    name: 'Tell people when they are assigned',
    description: 'When someone is assigned to an incident, notify that person in-app and by email.',
    rule: rule({
      name: 'Assignment notice',
      trigger: 'incident.assigned',
      actions: [
        {
          type: 'notify',
          recipients: { assignee: true },
          channels: ['in_app', 'email'],
          title: 'You were assigned INC-{{number}}: {{title}}',
          body: 'Severity {{severity}}, status {{status}}.',
        },
      ],
      cooldownSeconds: 0,
    }),
  },
  {
    id: 'failed-deployment-alert',
    name: 'Alert developers to failed deployments',
    description: 'When a deployment fails, notify owners, admins and developers in-app.',
    rule: rule({
      name: 'Deployment failed',
      trigger: 'deployment.failed',
      actions: [
        {
          type: 'notify',
          recipients: { roles: ['OWNER', 'ADMIN', 'DEVELOPER'] },
          channels: ['in_app'],
          title: 'Deployment failed: {{repoFullName}}@{{commitShort}}',
          body: '{{author}} deployed {{ref}} to {{environment}}.',
        },
      ],
    }),
  },
  {
    id: 'failed-production-deployment-incident',
    name: 'Open an incident for failed production deployments',
    description:
      'When a deployment to production fails, open a SEV-3 incident on the service and tell the team.',
    rule: rule({
      name: 'Failed production deployment',
      trigger: 'deployment.failed',
      conditions: [{ field: 'environment', operator: 'eq', value: 'production' }],
      actions: [
        {
          type: 'create_incident',
          title: 'Deployment failed: {{repoFullName}}@{{commitShort}}',
          description: '{{author}} deployed {{ref}} to {{environment}} and it failed.',
          severity: 'SEV3',
          attachEventService: true,
        },
        // An incident opened by an automation never triggers other rules (no automation chains),
        // so this rule also tells people itself.
        {
          type: 'notify',
          recipients: { roles: ['OWNER', 'ADMIN', 'DEVELOPER'] },
          channels: ['in_app'],
          title: 'Incident opened: deployment failed ({{repoFullName}}@{{commitShort}})',
          body: 'A SEV-3 incident was opened automatically for {{serviceName}}.',
        },
      ],
    }),
  },
];

// ---- DTOs --------------------------------------------------------------------------------------

export interface AutomationRuleDto {
  id: string;
  name: string;
  trigger: AutomationTrigger;
  conditions: Condition[];
  actions: AutomationAction[];
  enabled: boolean;
  cooldownSeconds: number;
  createdAt: string;
  updatedAt: string;
  lastExecutionAt: string | null;
  lastExecutionStatus: ExecutionStatus | null;
}

export interface AutomationExecutionDto {
  id: string;
  ruleId: string;
  eventType: AutomationTrigger;
  status: ExecutionStatus;
  skipReason: SkipReason | null;
  results: ActionResult[];
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
}

export interface NotificationDto {
  id: string;
  type: AutomationTrigger;
  title: string;
  body: string;
  /** An in-app path built by the server from ids, never from user input. */
  link: string | null;
  readAt: string | null;
  createdAt: string;
}

export interface OutboundWebhookDto {
  id: string;
  name: string;
  /** Origin and path only: the query string may carry a token. */
  url: string;
  enabled: boolean;
  createdAt: string;
}

export interface CreatedOutboundWebhookDto extends OutboundWebhookDto {
  /** Shown once. */
  signingSecret: string;
}

export const createOutboundWebhookSchema = z.object({
  name: z.string().trim().min(1).max(60),
  url: z.string().trim().min(1).max(2048),
});
export type CreateOutboundWebhookInput = z.infer<typeof createOutboundWebhookSchema>;

export const AUDIT_ACTIONS = [
  'automation.rule.created',
  'automation.rule.updated',
  'automation.rule.deleted',
  'automation.rule.enabled',
  'automation.rule.disabled',
  'automation.incident.created',
  'outbound_webhook.created',
  'outbound_webhook.disabled',
  'integration.github.created',
  'integration.github.disabled',
  'knowledge.document.created',
  'knowledge.document.updated',
  'knowledge.document.deleted',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export interface AuditLogDto {
  id: string;
  action: string;
  actorLabel: string;
  actorType: 'USER' | 'SYSTEM' | 'AUTOMATION';
  resourceType: string;
  resourceId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

// ---- API contracts: paging, queries and small request bodies -------------------------------------

export interface NotificationPageDto {
  data: NotificationDto[];
  /** Unread in-app notifications for the current user in this organization (the bell's badge). */
  unreadCount: number;
  nextBefore: string | null;
}

export interface ExecutionPageDto {
  data: AutomationExecutionDto[];
  nextBefore: string | null;
}

export interface AuditLogPageDto {
  data: AuditLogDto[];
  nextBefore: string | null;
}

const pageQuery = {
  limit: z.coerce.number().int().min(1).max(100).default(20),
  /** Return entries strictly older than this timestamp (the previous page's `nextBefore`). */
  before: z.iso.datetime().optional(),
};

export const pageQuerySchema = z.object(pageQuery);
export type PageQuery = z.infer<typeof pageQuerySchema>;

export const listNotificationsQuerySchema = z.object({
  ...pageQuery,
  unread: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => value === 'true'),
});
export type ListNotificationsQuery = z.infer<typeof listNotificationsQuerySchema>;

export const listAuditLogsQuerySchema = z.object({
  ...pageQuery,
  action: z.enum(AUDIT_ACTIONS).optional(),
});
export type ListAuditLogsQuery = z.infer<typeof listAuditLogsQuerySchema>;

/** Turning a rule on or off, without resending its whole definition. */
export const setRuleEnabledSchema = z.object({ enabled: z.boolean() }).strict();
export type SetRuleEnabledInput = z.infer<typeof setRuleEnabledSchema>;
