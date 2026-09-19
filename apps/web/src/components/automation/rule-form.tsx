'use client';

import {
  AUTOMATION_LIMITS,
  AUTOMATION_TRIGGERS,
  CHANNEL_LABEL,
  CONDITION_OPERATORS,
  INCIDENT_SEVERITIES,
  NOTIFICATION_CHANNELS,
  OPERATOR_LABEL,
  ROLES,
  RULE_TEMPLATES,
  SEVERITY_LABEL,
  TRIGGER_FIELDS,
  TRIGGER_LABEL,
  createRuleSchema,
  isIncidentTrigger,
  type AutomationRuleDto,
  type AutomationTrigger,
  type CreateRuleInput,
  type IncidentSeverity,
  type NotificationChannel,
  type OutboundWebhookDto,
  type Role,
} from '@nexus/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/feedback';
import { Field, Input, Select } from '@/components/ui/field';
import { Textarea } from '@/components/ui/textarea';
import { ApiError, apiFetch, describeError } from '@/lib/api-client';
import { factValueLabel } from '@/lib/automation-format';
import { keys } from '@/lib/queries';

// ---- The form's own state: plain strings and booleans, converted to a rule when saving ----------

interface ConditionDraft {
  field: string;
  operator: (typeof CONDITION_OPERATORS)[number];
  /** For "is" / "is not", and for free-text lists ("a, b, c"). */
  value: string;
  /** For "is one of" / "is none of" on a field with fixed values. */
  values: string[];
}

type ActionDraft =
  | {
      type: 'notify';
      roles: Role[];
      /** Kept when editing a rule that names people; the form does not add to them. */
      userIds: string[];
      assignee: boolean;
      incidentAssignees: boolean;
      channels: NotificationChannel[];
      title: string;
      body: string;
    }
  | { type: 'webhook'; destinationId: string }
  | {
      type: 'create_incident';
      title: string;
      description: string;
      severity: IncidentSeverity;
      attachEventService: boolean;
    };

interface Draft {
  name: string;
  trigger: AutomationTrigger;
  conditions: ConditionDraft[];
  actions: ActionDraft[];
  cooldownSeconds: string;
  enabled: boolean;
}

const emptyNotify = (): ActionDraft => ({
  type: 'notify',
  roles: ['OWNER', 'ADMIN'],
  userIds: [],
  assignee: false,
  incidentAssignees: false,
  channels: ['in_app'],
  title: '',
  body: '',
});

function draftFromRule(rule: CreateRuleInput | AutomationRuleDto): Draft {
  return {
    name: rule.name,
    trigger: rule.trigger,
    cooldownSeconds: String(rule.cooldownSeconds),
    enabled: rule.enabled,
    conditions: rule.conditions.map((condition) => {
      const list = Array.isArray(condition.value);
      const field = TRIGGER_FIELDS[rule.trigger].find((f) => f.name === condition.field);
      return {
        field: condition.field,
        operator: condition.operator,
        value: Array.isArray(condition.value)
          ? condition.value.join(', ')
          : String(condition.value),
        values: list && field?.kind === 'enum' ? (condition.value as unknown[]).map(String) : [],
      };
    }),
    actions: rule.actions.map((action): ActionDraft => {
      if (action.type === 'notify')
        return {
          type: 'notify',
          ...action.recipients,
          channels: action.channels,
          title: action.title,
          body: action.body,
        };
      if (action.type === 'webhook')
        return { type: 'webhook', destinationId: action.destinationId };
      return {
        type: 'create_incident',
        title: action.title,
        description: action.description,
        severity: action.severity,
        attachEventService: action.attachEventService,
      };
    }),
  };
}

/** The draft as the API expects a rule. Not yet validated: `createRuleSchema` does that. */
function toPayload(draft: Draft): unknown {
  return {
    name: draft.name,
    trigger: draft.trigger,
    enabled: draft.enabled,
    cooldownSeconds:
      draft.cooldownSeconds.trim() === '' ? Number.NaN : Number(draft.cooldownSeconds),
    conditions: draft.conditions.map((condition) => {
      const field = TRIGGER_FIELDS[draft.trigger].find((f) => f.name === condition.field);
      const wantsList = condition.operator === 'in' || condition.operator === 'not_in';
      const parse = (text: string) =>
        field?.kind === 'number' && text.trim() !== '' ? Number(text) : text.trim();
      if (!wantsList)
        return {
          field: condition.field,
          operator: condition.operator,
          value: parse(condition.value),
        };
      const list =
        field?.kind === 'enum'
          ? condition.values
          : condition.value
              .split(',')
              .map((part) => parse(part))
              .filter((part) => part !== '');
      return { field: condition.field, operator: condition.operator, value: list };
    }),
    actions: draft.actions.map((action) => {
      if (action.type === 'notify') {
        return {
          type: 'notify',
          recipients: {
            roles: action.roles,
            userIds: action.userIds,
            assignee: action.assignee,
            incidentAssignees: action.incidentAssignees,
          },
          channels: action.channels,
          title: action.title,
          body: action.body,
        };
      }
      return action;
    }),
  };
}

/** "Condition 2: …" / "Action 1: …": the schema's paths, in words a person can act on. */
function describeIssue(issue: { path: readonly PropertyKey[]; message: string }): string {
  const [head, index] = issue.path;
  if (head === 'conditions' && typeof index === 'number')
    return `Condition ${index + 1}: ${issue.message}`;
  if (head === 'actions' && typeof index === 'number')
    return `Action ${index + 1}: ${issue.message}`;
  if (head === 'name') return `Name: ${issue.message}`;
  if (head === 'cooldownSeconds')
    return 'Cooldown must be a whole number of seconds between 0 and 86400';
  return issue.message;
}

// ---- The form ----------------------------------------------------------------------------------

export function RuleForm({
  orgId,
  rule,
  webhooks,
  onDone,
}: {
  orgId: string;
  /** The rule being edited; omit to create a new one. */
  rule?: AutomationRuleDto;
  webhooks: OutboundWebhookDto[];
  onDone: () => void;
}) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Draft>(() =>
    rule
      ? draftFromRule(rule)
      : {
          name: '',
          trigger: 'incident.created',
          conditions: [],
          actions: [emptyNotify()],
          cooldownSeconds: String(AUTOMATION_LIMITS.cooldownSeconds.default),
          enabled: true,
        },
  );
  const [problems, setProblems] = useState<string[]>([]);

  const save = useMutation({
    mutationFn: (input: CreateRuleInput) =>
      rule
        ? apiFetch<AutomationRuleDto>(`/orgs/${orgId}/automation/rules/${rule.id}`, {
            method: 'PUT',
            body: input,
          })
        : apiFetch<AutomationRuleDto>(`/orgs/${orgId}/automation/rules`, {
            method: 'POST',
            body: input,
          }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: keys.rules(orgId) });
      onDone();
    },
  });

  const set = (patch: Partial<Draft>) => setDraft((current) => ({ ...current, ...patch }));
  const setAction = (index: number, action: ActionDraft) =>
    set({ actions: draft.actions.map((existing, i) => (i === index ? action : existing)) });
  const setCondition = (index: number, patch: Partial<ConditionDraft>) =>
    set({
      conditions: draft.conditions.map((existing, i) =>
        i === index ? { ...existing, ...patch } : existing,
      ),
    });

  /** Changing the trigger changes which facts exist, so anything that relied on the old ones is reset. */
  function changeTrigger(trigger: AutomationTrigger) {
    setDraft((current) => ({
      ...current,
      trigger,
      conditions: [],
      actions: current.actions.map((action) =>
        action.type === 'notify'
          ? { ...action, assignee: false, incidentAssignees: false, title: '', body: '' }
          : action.type === 'create_incident'
            ? { ...action, title: '', description: '' }
            : action,
      ),
    }));
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    const parsed = createRuleSchema.safeParse(toPayload(draft));
    if (!parsed.success) {
      setProblems(parsed.error.issues.map(describeIssue));
      return;
    }
    setProblems([]);
    save.mutate(parsed.data);
  }

  const facts = TRIGGER_FIELDS[draft.trigger];
  const placeholders = facts.filter((f) => f.kind !== 'id').map((f) => `{{${f.name}}}`);
  const hasService = facts.some((f) => f.name === 'serviceId');
  const serverIssues =
    save.error instanceof ApiError && save.error.details.length > 0
      ? save.error.details.map((d) => `${d.path ? `${d.path}: ` : ''}${d.message}`)
      : [];

  return (
    <form
      onSubmit={submit}
      noValidate
      aria-label={rule ? 'Edit rule' : 'New rule'}
      className="space-y-6"
    >
      {!rule && (
        <Field
          label="Start from a template"
          htmlFor="rule-template"
          hint="Optional. It fills in the form; you can change anything."
        >
          <Select
            id="rule-template"
            value=""
            onChange={(e) => {
              const template = RULE_TEMPLATES.find((t) => t.id === e.target.value);
              if (template) {
                setDraft(draftFromRule(template.rule));
                setProblems([]);
              }
            }}
          >
            <option value="">Choose a template…</option>
            {RULE_TEMPLATES.map((template) => (
              <option key={template.id} value={template.id}>
                {template.name}
              </option>
            ))}
          </Select>
        </Field>
      )}

      {(problems.length > 0 || save.isError) && (
        <Alert>
          {problems.length > 0 || serverIssues.length > 0 ? (
            <>
              <p className="font-medium">Please fix the following:</p>
              <ul className="mt-1 list-disc pl-5">
                {(problems.length > 0 ? problems : serverIssues).map((problem) => (
                  <li key={problem}>{problem}</li>
                ))}
              </ul>
            </>
          ) : (
            describeError(save.error)
          )}
        </Alert>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Rule name" htmlFor="rule-name">
          <Input
            id="rule-name"
            value={draft.name}
            maxLength={AUTOMATION_LIMITS.nameMax}
            onChange={(e) => set({ name: e.target.value })}
          />
        </Field>
        <Field label="When this happens" htmlFor="rule-trigger">
          <Select
            id="rule-trigger"
            value={draft.trigger}
            onChange={(e) => changeTrigger(e.target.value as AutomationTrigger)}
          >
            {AUTOMATION_TRIGGERS.map((trigger) => (
              <option key={trigger} value={trigger}>
                {TRIGGER_LABEL[trigger]}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      <fieldset className="space-y-3">
        <legend className="text-sm font-medium">Only when (optional)</legend>
        {draft.conditions.map((condition, index) => (
          <ConditionRow
            key={index}
            index={index}
            trigger={draft.trigger}
            condition={condition}
            onChange={(patch) => setCondition(index, patch)}
            onRemove={() => set({ conditions: draft.conditions.filter((_, i) => i !== index) })}
          />
        ))}
        {draft.conditions.length < AUTOMATION_LIMITS.maxConditionsPerRule && (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              const first = facts.find((f) => f.kind === 'enum') ?? facts[0]!;
              set({
                conditions: [
                  ...draft.conditions,
                  { field: first.name, operator: 'eq', value: first.values?.[0] ?? '', values: [] },
                ],
              });
            }}
          >
            Add condition
          </Button>
        )}
      </fieldset>

      <fieldset className="space-y-4">
        <legend className="text-sm font-medium">Then</legend>
        {draft.actions.map((action, index) => (
          <ActionEditor
            key={index}
            index={index}
            trigger={draft.trigger}
            action={action}
            webhooks={webhooks}
            placeholders={placeholders}
            hasService={hasService}
            canRemove={draft.actions.length > 1}
            onChange={(next) => setAction(index, next)}
            onRemove={() => set({ actions: draft.actions.filter((_, i) => i !== index) })}
          />
        ))}
        {draft.actions.length < AUTOMATION_LIMITS.maxActionsPerRule && (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => set({ actions: [...draft.actions, emptyNotify()] })}
          >
            Add action
          </Button>
        )}
      </fieldset>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Cooldown (seconds)"
          htmlFor="rule-cooldown"
          hint="After it runs for an item, it will not run again for that same item for this long. 0 turns it off."
        >
          <Input
            id="rule-cooldown"
            inputMode="numeric"
            value={draft.cooldownSeconds}
            onChange={(e) => set({ cooldownSeconds: e.target.value })}
          />
        </Field>
        <label className="flex items-center gap-2 self-end pb-2 text-sm">
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={(e) => set({ enabled: e.target.checked })}
          />
          Turned on
        </label>
      </div>

      <div className="flex gap-2">
        <Button type="submit" loading={save.isPending}>
          {rule ? 'Save changes' : 'Save rule'}
        </Button>
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

// ---- Conditions --------------------------------------------------------------------------------

function ConditionRow({
  index,
  trigger,
  condition,
  onChange,
  onRemove,
}: {
  index: number;
  trigger: AutomationTrigger;
  condition: ConditionDraft;
  onChange: (patch: Partial<ConditionDraft>) => void;
  onRemove: () => void;
}) {
  const fields = TRIGGER_FIELDS[trigger];
  const field = fields.find((f) => f.name === condition.field) ?? fields[0]!;
  const n = index + 1;
  const wantsList = condition.operator === 'in' || condition.operator === 'not_in';

  return (
    <div className="grid gap-2 rounded-lg border border-border p-3 sm:grid-cols-[1fr_9rem_1.4fr_auto]">
      <Select
        aria-label={`Condition ${n} field`}
        value={field.name}
        onChange={(e) => {
          const next = fields.find((f) => f.name === e.target.value)!;
          onChange({ field: next.name, value: next.values?.[0] ?? '', values: [] });
        }}
      >
        {fields.map((f) => (
          <option key={f.name} value={f.name}>
            {f.label}
          </option>
        ))}
      </Select>
      <Select
        aria-label={`Condition ${n} operator`}
        value={condition.operator}
        onChange={(e) => onChange({ operator: e.target.value as ConditionDraft['operator'] })}
      >
        {CONDITION_OPERATORS.map((operator) => (
          <option key={operator} value={operator}>
            {OPERATOR_LABEL[operator]}
          </option>
        ))}
      </Select>
      {field.kind === 'enum' && !wantsList && (
        <Select
          aria-label={`Condition ${n} value`}
          value={condition.value}
          onChange={(e) => onChange({ value: e.target.value })}
        >
          {field.values!.map((value) => (
            <option key={value} value={value}>
              {factValueLabel(value)}
            </option>
          ))}
        </Select>
      )}
      {field.kind === 'enum' && wantsList && (
        <div
          role="group"
          aria-label={`Condition ${n} values`}
          className="flex flex-wrap gap-x-4 gap-y-1 self-center text-sm"
        >
          {field.values!.map((value) => (
            <label key={value} className="flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={condition.values.includes(value)}
                onChange={(e) =>
                  onChange({
                    values: e.target.checked
                      ? [...condition.values, value]
                      : condition.values.filter((v) => v !== value),
                  })
                }
              />
              {factValueLabel(value)}
            </label>
          ))}
        </div>
      )}
      {field.kind !== 'enum' && (
        <Input
          aria-label={`Condition ${n} value`}
          value={condition.value}
          placeholder={wantsList ? 'one, two, three' : 'value'}
          onChange={(e) => onChange({ value: e.target.value })}
        />
      )}
      <Button size="sm" variant="ghost" aria-label={`Remove condition ${n}`} onClick={onRemove}>
        Remove
      </Button>
    </div>
  );
}

// ---- Actions -----------------------------------------------------------------------------------

function ActionEditor({
  index,
  trigger,
  action,
  webhooks,
  placeholders,
  hasService,
  canRemove,
  onChange,
  onRemove,
}: {
  index: number;
  trigger: AutomationTrigger;
  action: ActionDraft;
  webhooks: OutboundWebhookDto[];
  placeholders: string[];
  hasService: boolean;
  canRemove: boolean;
  onChange: (next: ActionDraft) => void;
  onRemove: () => void;
}) {
  const n = index + 1;
  const id = `action-${index}`;

  function changeType(type: ActionDraft['type']) {
    if (type === action.type) return;
    if (type === 'notify') onChange(emptyNotify());
    else if (type === 'webhook')
      onChange({ type: 'webhook', destinationId: webhooks[0]?.id ?? '' });
    else
      onChange({
        type: 'create_incident',
        title: '',
        description: '',
        severity: 'SEV3',
        attachEventService: true,
      });
  }

  return (
    <div className="space-y-3 rounded-lg border border-border p-4">
      <div className="flex items-center justify-between gap-3">
        <Select
          aria-label={`Action ${n} type`}
          value={action.type}
          onChange={(e) => changeType(e.target.value as ActionDraft['type'])}
          className="max-w-xs"
        >
          <option value="notify">Send a notification</option>
          <option value="webhook">Call a webhook</option>
          <option value="create_incident">Open an incident</option>
        </Select>
        {canRemove && (
          <Button size="sm" variant="ghost" aria-label={`Remove action ${n}`} onClick={onRemove}>
            Remove
          </Button>
        )}
      </div>

      {action.type === 'notify' && (
        <>
          <div role="group" aria-label={`Action ${n} recipients`} className="space-y-1">
            <p className="text-sm font-medium">Who to tell</p>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
              {ROLES.map((role) => (
                <label key={role} className="flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={action.roles.includes(role)}
                    onChange={(e) =>
                      onChange({
                        ...action,
                        roles: e.target.checked
                          ? [...action.roles, role]
                          : action.roles.filter((r) => r !== role),
                      })
                    }
                  />
                  {role.charAt(0) + role.slice(1).toLowerCase()}s
                </label>
              ))}
              {trigger === 'incident.assigned' && (
                <label className="flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={action.assignee}
                    onChange={(e) => onChange({ ...action, assignee: e.target.checked })}
                  />
                  The person assigned
                </label>
              )}
              {isIncidentTrigger(trigger) && (
                <label className="flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={action.incidentAssignees}
                    onChange={(e) => onChange({ ...action, incidentAssignees: e.target.checked })}
                  />
                  Everyone on the incident
                </label>
              )}
            </div>
            {action.userIds.length > 0 && (
              <p className="text-xs text-muted">
                Also {action.userIds.length} named{' '}
                {action.userIds.length === 1 ? 'person' : 'people'} on this rule.
              </p>
            )}
          </div>
          <div
            role="group"
            aria-label={`Action ${n} channels`}
            className="flex flex-wrap gap-x-4 text-sm"
          >
            {NOTIFICATION_CHANNELS.map((channel) => (
              <label key={channel} className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={action.channels.includes(channel)}
                  onChange={(e) =>
                    onChange({
                      ...action,
                      channels: e.target.checked
                        ? [...action.channels, channel]
                        : action.channels.filter((c) => c !== channel),
                    })
                  }
                />
                {CHANNEL_LABEL[channel]}
              </label>
            ))}
          </div>
          <Field label="Title" htmlFor={`${id}-title`}>
            <Input
              id={`${id}-title`}
              value={action.title}
              maxLength={AUTOMATION_LIMITS.titleMax}
              onChange={(e) => onChange({ ...action, title: e.target.value })}
            />
          </Field>
          <Field label="Message (optional)" htmlFor={`${id}-body`}>
            <Textarea
              id={`${id}-body`}
              value={action.body}
              maxLength={AUTOMATION_LIMITS.bodyMax}
              onChange={(e) => onChange({ ...action, body: e.target.value })}
            />
          </Field>
          <Placeholders placeholders={placeholders} />
        </>
      )}

      {action.type === 'webhook' && (
        <Field
          label="Webhook"
          htmlFor={`${id}-webhook`}
          hint={webhooks.length === 0 ? 'Add a webhook under Integrations first.' : undefined}
        >
          <Select
            id={`${id}-webhook`}
            value={action.destinationId}
            onChange={(e) => onChange({ ...action, destinationId: e.target.value })}
          >
            <option value="">Choose a webhook…</option>
            {webhooks.map((webhook) => (
              <option key={webhook.id} value={webhook.id}>
                {webhook.name}
              </option>
            ))}
          </Select>
        </Field>
      )}

      {action.type === 'create_incident' && (
        <>
          <Field label="Incident title" htmlFor={`${id}-incident-title`}>
            <Input
              id={`${id}-incident-title`}
              value={action.title}
              maxLength={AUTOMATION_LIMITS.titleMax}
              onChange={(e) => onChange({ ...action, title: e.target.value })}
            />
          </Field>
          <Field label="Description (optional)" htmlFor={`${id}-incident-description`}>
            <Textarea
              id={`${id}-incident-description`}
              value={action.description}
              maxLength={AUTOMATION_LIMITS.bodyMax}
              onChange={(e) => onChange({ ...action, description: e.target.value })}
            />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Severity" htmlFor={`${id}-severity`}>
              <Select
                id={`${id}-severity`}
                value={action.severity}
                onChange={(e) =>
                  onChange({ ...action, severity: e.target.value as IncidentSeverity })
                }
              >
                {INCIDENT_SEVERITIES.map((severity) => (
                  <option key={severity} value={severity}>
                    {SEVERITY_LABEL[severity]}
                  </option>
                ))}
              </Select>
            </Field>
            {hasService && (
              <label className="flex items-center gap-2 self-end pb-2 text-sm">
                <input
                  type="checkbox"
                  checked={action.attachEventService}
                  onChange={(e) => onChange({ ...action, attachEventService: e.target.checked })}
                />
                Attach it to the service in the event
              </label>
            )}
          </div>
          <Placeholders placeholders={placeholders} />
          <p className="text-xs text-muted">
            An incident opened by an automation does not trigger other rules. Add a notification
            action to this rule if people should be told.
          </p>
        </>
      )}
    </div>
  );
}

function Placeholders({ placeholders }: { placeholders: string[] }) {
  return (
    <p className="text-xs text-muted">
      You can use{' '}
      {placeholders.map((placeholder, i) => (
        <span key={placeholder}>
          <code className="rounded bg-white/5 px-1 py-0.5 font-mono">{placeholder}</code>
          {i < placeholders.length - 1 ? ' ' : ''}
        </span>
      ))}{' '}
      in the text. They are replaced with the real values, as plain text.
    </p>
  );
}
