import { AUDIT_ACTIONS, RULE_TEMPLATES } from '@nexus/shared';
import { describe, expect, it } from 'vitest';
import {
  describeAction,
  describeAudit,
  describeCondition,
  describeRecipients,
  factValueLabel,
  fieldLabel,
} from './automation-format';

describe('describeCondition', () => {
  it('reads like a sentence, with friendly labels', () => {
    expect(
      describeCondition('incident.created', {
        field: 'severity',
        operator: 'in',
        value: ['SEV1', 'SEV2'],
      }),
    ).toBe('Severity is one of SEV-1, SEV-2');
    expect(
      describeCondition('service.health_changed', {
        field: 'toHealth',
        operator: 'eq',
        value: 'DOWN',
      }),
    ).toBe('New health is Down');
    expect(
      describeCondition('deployment.failed', {
        field: 'environment',
        operator: 'neq',
        value: 'staging',
      }),
    ).toBe('Environment is not staging');
  });

  it('falls back to the raw name for a field it does not know', () => {
    expect(fieldLabel('incident.created', 'mystery')).toBe('mystery');
    expect(factValueLabel('anything')).toBe('anything');
  });
});

describe('describeAction', () => {
  it('summarises every action type', () => {
    const [notify] = RULE_TEMPLATES[0]!.rule.actions;
    expect(describeAction(notify!)).toBe('Notify owners, admins (in-app, email)');
    const incident = RULE_TEMPLATES.find((t) => t.id === 'failed-production-deployment-incident')!
      .rule.actions[0]!;
    expect(describeAction(incident)).toBe('Open a SEV-3 incident');
    const hook = { type: 'webhook' as const, destinationId: 'a' };
    expect(describeAction(hook, new Map([['a', 'Pager']]))).toBe('Call the webhook “Pager”');
    expect(describeAction(hook)).toBe('Call a webhook (no longer available)');
  });

  it('describes recipients of every kind', () => {
    expect(
      describeRecipients({ roles: [], userIds: [], incidentAssignees: false, assignee: true }),
    ).toBe('the person assigned');
    expect(
      describeRecipients({
        roles: ['DEVELOPER'],
        userIds: ['x', 'y'],
        incidentAssignees: true,
        assignee: false,
      }),
    ).toBe('developers, everyone on the incident, 2 named people');
    expect(
      describeRecipients({ roles: [], userIds: ['x'], incidentAssignees: false, assignee: false }),
    ).toBe('1 named person');
  });
});

describe('describeAudit', () => {
  it('has wording for every audit action', () => {
    for (const action of AUDIT_ACTIONS) {
      expect(describeAudit({ action, metadata: {} }), action).not.toBe(action);
    }
  });

  it('names what was changed when it can', () => {
    expect(describeAudit({ action: 'automation.rule.created', metadata: { name: 'Alert' } })).toBe(
      'created the automation rule “Alert”',
    );
    expect(
      describeAudit({ action: 'integration.github.created', metadata: { repository: 'acme/x' } }),
    ).toBe('connected the GitHub repository “acme/x”');
    expect(
      describeAudit({ action: 'automation.incident.created', metadata: { incidentNumber: 7 } }),
    ).toBe('opened an incident (automation) “INC-7”');
  });

  it('shows an unknown action as-is rather than hiding it', () => {
    expect(describeAudit({ action: 'something.new', metadata: {} })).toBe('something.new');
  });
});
