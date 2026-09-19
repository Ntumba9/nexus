import { describe, expect, it } from 'vitest';
import {
  AUTOMATION_LIMITS,
  AUTOMATION_TRIGGERS,
  RULE_TEMPLATES,
  TRIGGER_FIELDS,
  createRuleSchema,
  evaluateConditions,
  extractPlaceholders,
  renderTemplate,
  type Condition,
} from './automation';

const NUL = String.fromCharCode(0);
const BEL = String.fromCharCode(7);

const notify = (over: Record<string, unknown> = {}) => ({
  type: 'notify',
  recipients: { roles: ['ADMIN'] },
  channels: ['in_app'],
  title: 'Hello',
  ...over,
});

const rule = (over: Record<string, unknown> = {}) => ({
  name: 'A rule',
  trigger: 'incident.created',
  actions: [notify()],
  ...over,
});

const issues = (input: unknown): string[] => {
  const result = createRuleSchema.safeParse(input);
  return result.success ? [] : result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
};

describe('evaluateConditions', () => {
  const facts = { severity: 'SEV1', status: 'OPEN', number: 7, resolved: false, serviceName: null };
  const c = (
    field: string,
    operator: Condition['operator'],
    value: Condition['value'],
  ): Condition => ({
    field,
    operator,
    value,
  });

  it('matches everything when there are no conditions', () => {
    expect(evaluateConditions([], facts)).toBe(true);
  });

  it.each([
    [c('severity', 'eq', 'SEV1'), true],
    [c('severity', 'eq', 'SEV2'), false],
    [c('severity', 'neq', 'SEV2'), true],
    [c('severity', 'neq', 'SEV1'), false],
    [c('severity', 'in', ['SEV1', 'SEV2']), true],
    [c('severity', 'in', ['SEV3']), false],
    [c('severity', 'not_in', ['SEV3', 'SEV4']), true],
    [c('severity', 'not_in', ['SEV1']), false],
    [c('number', 'eq', 7), true],
    [c('number', 'eq', '7'), false], // no silent type coercion
    [c('resolved', 'eq', false), true],
  ])('%j → %s', (condition, expected) => {
    expect(evaluateConditions([condition], facts)).toBe(expected);
  });

  it('never matches "is" / "is one of" on a missing or null fact, but does for the negations', () => {
    for (const field of ['serviceName', 'unknownField']) {
      expect(evaluateConditions([c(field, 'eq', 'x')], facts)).toBe(false);
      expect(evaluateConditions([c(field, 'in', ['x'])], facts)).toBe(false);
      expect(evaluateConditions([c(field, 'neq', 'x')], facts)).toBe(true);
      expect(evaluateConditions([c(field, 'not_in', ['x'])], facts)).toBe(true);
    }
  });

  it('ignores inherited properties: `constructor` is not a fact', () => {
    expect(evaluateConditions([c('constructor', 'eq', 'x')], {})).toBe(false);
    expect(evaluateConditions([c('toString', 'neq', 'x')], {})).toBe(true);
  });

  it('ANDs its conditions', () => {
    const both = [c('severity', 'eq', 'SEV1'), c('status', 'eq', 'OPEN')];
    expect(evaluateConditions(both, facts)).toBe(true);
    expect(evaluateConditions([...both, c('status', 'eq', 'RESOLVED')], facts)).toBe(false);
  });
});

describe('renderTemplate', () => {
  const facts = { title: 'DB down', number: 42, severity: 'SEV1', empty: null };

  it('substitutes known facts and empties unknown or null ones', () => {
    expect(renderTemplate('INC-{{number}}: {{title}} [{{ severity }}]', facts)).toBe(
      'INC-42: DB down [SEV1]',
    );
    expect(renderTemplate('a{{nope}}b{{empty}}c', facts)).toBe('abc');
  });

  it('does plain substitution only: no expressions, no code, no recursion', () => {
    const hostile = {
      title: '{{severity}} ${process.env.SECRET} <script>alert(1)</script>',
      severity: 'SEV1',
    };
    const out = renderTemplate('{{title}}', hostile);
    expect(out).toBe('{{severity}} ${process.env.SECRET} <script>alert(1)</script>'); // not re-expanded
    expect(renderTemplate('{{constructor}} {{toString}} {{hasOwnProperty}}', {})).toBe('');
    // Not valid placeholder syntax at all, so it is left exactly as written.
    expect(renderTemplate('{{__proto__}}', {})).toBe('{{__proto__}}');
  });

  it('strips control characters and collapses line breaks for single-line output (header injection)', () => {
    const out = renderTemplate(
      'Subject: {{title}}',
      { title: 'x\r\nBcc: attacker@example.com' + NUL },
      { singleLine: true },
    );
    expect(out).not.toMatch(/[\r\n]/);
    expect(out).not.toContain(NUL);
    expect(out).toBe('Subject: x Bcc: attacker@example.com');
  });

  it('keeps line breaks in multi-line bodies but not other control characters', () => {
    expect(renderTemplate('{{title}}', { title: 'a\nb' + BEL + 'c' })).toBe('a\nbc');
  });

  it('bounds each value and the whole result', () => {
    const long = 'x'.repeat(5000);
    expect(renderTemplate('{{title}}', { title: long }).length).toBe(
      AUTOMATION_LIMITS.placeholderValueMax,
    );
    expect(renderTemplate('{{title}}{{title}}', { title: long }, { maxLength: 250 }).length).toBe(
      250,
    );
  });

  it('extracts placeholders', () => {
    expect(extractPlaceholders('{{a}} and {{ b }} and {{a}} but not { {c} } or {{1x}}')).toEqual([
      'a',
      'b',
      'a',
    ]);
  });
});

describe('createRuleSchema', () => {
  it('accepts a valid rule and fills the defaults', () => {
    const parsed = createRuleSchema.parse(rule());
    expect(parsed).toMatchObject({
      enabled: true,
      cooldownSeconds: AUTOMATION_LIMITS.cooldownSeconds.default,
      conditions: [],
    });
    expect(parsed.actions[0]).toMatchObject({ type: 'notify', body: '' });
  });

  it('rejects unknown triggers, empty or oversized action lists and bad names', () => {
    expect(issues(rule({ trigger: 'incident.exploded' }))).not.toEqual([]);
    expect(issues(rule({ actions: [] }))).not.toEqual([]);
    expect(issues(rule({ actions: Array.from({ length: 6 }, () => notify()) }))).not.toEqual([]);
    expect(issues(rule({ name: '   ' }))).not.toEqual([]);
    expect(issues(rule({ name: 'x'.repeat(81) }))).not.toEqual([]);
  });

  it('only allows the action types on the allow-list, with their exact shapes', () => {
    expect(issues(rule({ actions: [{ type: 'shell', command: 'rm -rf /' }] }))).not.toEqual([]);
    expect(
      issues(rule({ actions: [{ type: 'webhook', destinationId: 'not-a-uuid' }] })),
    ).not.toEqual([]);
    expect(
      issues(
        rule({
          actions: [{ type: 'webhook', destinationId: '3f1c1f0e-6f0e-4d5e-9d64-0a6f2e2f9a10' }],
        }),
      ),
    ).toEqual([]);
    // extra keys are stripped, never carried through
    const parsed = createRuleSchema.parse(rule({ actions: [{ ...notify(), evil: 'x' }] }));
    expect(parsed.actions[0]).not.toHaveProperty('evil');
  });

  it('validates conditions against the trigger: fields, operator shape and enum values', () => {
    expect(
      issues(rule({ conditions: [{ field: 'severity', operator: 'eq', value: 'SEV1' }] })),
    ).toEqual([]);
    expect(
      issues(rule({ conditions: [{ field: 'toHealth', operator: 'eq', value: 'DOWN' }] })),
    ).toContain('conditions.0.field: "toHealth" is not available for this trigger');
    expect(
      issues(rule({ conditions: [{ field: 'severity', operator: 'in', value: 'SEV1' }] })),
    ).toContain('conditions.0.value: provide a list of values');
    expect(
      issues(rule({ conditions: [{ field: 'severity', operator: 'eq', value: ['SEV1'] }] })),
    ).toContain('conditions.0.value: provide a single value');
    expect(
      issues(rule({ conditions: [{ field: 'severity', operator: 'eq', value: 'SEV9' }] }))[0],
    ).toContain('not a valid severity');
    expect(
      issues(
        rule({
          conditions: Array.from({ length: 11 }, () => ({
            field: 'severity',
            operator: 'eq',
            value: 'SEV1',
          })),
        }),
      ),
    ).not.toEqual([]);
  });

  it('only allows placeholders the trigger provides', () => {
    expect(issues(rule({ actions: [notify({ title: '{{title}} {{number}}' })] }))).toEqual([]);
    expect(issues(rule({ actions: [notify({ title: '{{toHealth}}' })] }))).toContain(
      'actions.0: {{toHealth}} is not available for this trigger',
    );
    expect(issues(rule({ actions: [notify({ body: '{{password}}' })] }))).not.toEqual([]);
  });

  it('checks recipients against the trigger', () => {
    const only = (recipients: Record<string, unknown>, trigger = 'incident.created') =>
      issues(rule({ trigger, actions: [notify({ recipients })] }));
    expect(only({})).not.toEqual([]); // nobody chosen
    expect(only({ roles: ['GOD'] })).not.toEqual([]);
    expect(only({ incidentAssignees: true })).toEqual([]);
    expect(only({ incidentAssignees: true }, 'service.health_changed')).not.toEqual([]);
    expect(only({ assignee: true }, 'incident.assigned')).toEqual([]);
    expect(only({ assignee: true }, 'incident.created')).not.toEqual([]);
    expect(
      only({ userIds: Array.from({ length: 26 }, () => '3f1c1f0e-6f0e-4d5e-9d64-0a6f2e2f9a10') }),
    ).not.toEqual([]);
  });

  it('bounds the cooldown', () => {
    expect(issues(rule({ cooldownSeconds: -1 }))).not.toEqual([]);
    expect(issues(rule({ cooldownSeconds: 86_401 }))).not.toEqual([]);
    expect(issues(rule({ cooldownSeconds: 0 }))).toEqual([]);
  });
});

describe('catalogue and templates', () => {
  it('describes fields for every trigger, with unique names and enum values', () => {
    for (const trigger of AUTOMATION_TRIGGERS) {
      const names = TRIGGER_FIELDS[trigger].map((field) => field.name);
      expect(names.length, trigger).toBeGreaterThan(0);
      expect(new Set(names).size, trigger).toBe(names.length);
      for (const field of TRIGGER_FIELDS[trigger]) {
        if (field.kind === 'enum')
          expect(field.values?.length, `${trigger}.${field.name}`).toBeGreaterThan(0);
      }
    }
  });

  it('ships templates that are all valid rules, with unique ids, and stay valid when re-parsed', () => {
    expect(RULE_TEMPLATES.length).toBeGreaterThan(0);
    expect(new Set(RULE_TEMPLATES.map((t) => t.id)).size).toBe(RULE_TEMPLATES.length);
    for (const template of RULE_TEMPLATES) {
      expect(createRuleSchema.safeParse(template.rule).success, template.id).toBe(true);
    }
  });

  it('templates never reference a webhook destination (those are organization-specific)', () => {
    for (const template of RULE_TEMPLATES) {
      expect(
        template.rule.actions.some((a) => a.type === 'webhook'),
        template.id,
      ).toBe(false);
    }
  });
});
