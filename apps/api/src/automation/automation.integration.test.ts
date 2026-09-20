import { randomBytes, randomUUID } from 'node:crypto';
import type {
  AutomationRuleDto,
  AuditLogPageDto,
  CreatedOutboundWebhookDto,
  ExecutionPageDto,
  NotificationPageDto,
  Role,
} from '@nexus/shared';
import { decryptSecret } from '@nexus/shared/webhook-security';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createProject } from '../testing/fixtures';
import {
  HAS_INFRA,
  createOrg,
  createTestApp,
  registerUser,
  userWithRole,
  type TestApp,
  type TestUser,
} from '../testing/harness';

const KEY = randomBytes(32).toString('base64');
const ROLES: Role[] = ['OWNER', 'ADMIN', 'DEVELOPER', 'SUPPORT', 'VIEWER'];
/** Hand-written expectations, independent of the shared permission map. */
const MANAGES: Role[] = ['OWNER', 'ADMIN'];

const notify = (over: Record<string, unknown> = {}) => ({
  type: 'notify',
  recipients: { roles: ['ADMIN'] },
  channels: ['in_app'],
  title: 'INC-{{number}}: {{title}}',
  body: 'On {{serviceName}}.',
  ...over,
});
const ruleBody = (over: Record<string, unknown> = {}) => ({
  name: 'Critical incident alert',
  trigger: 'incident.created',
  conditions: [{ field: 'severity', operator: 'in', value: ['SEV1', 'SEV2'] }],
  actions: [notify()],
  ...over,
});

describe.skipIf(!HAS_INFRA)('automation API (integration)', () => {
  let t: TestApp;
  let owner: TestUser;
  let orgId: string;
  const actors = {} as Record<Role, TestUser & { memberId: string }>;

  beforeAll(async () => {
    t = await createTestApp({ env: { INTEGRATION_ENCRYPTION_KEY: KEY } });
    owner = await registerUser(t, 'Automation Owner');
    orgId = (await createOrg(owner, 'Automation Org')).id;
    for (const role of ROLES) actors[role] = await userWithRole(t, orgId, role);
  });
  afterAll(() => t.close());

  const createRule = async (
    user: TestUser = owner,
    org = orgId,
    over: Record<string, unknown> = {},
  ) => {
    const res = await user.client.post(`/orgs/${org}/automation/rules`, ruleBody(over));
    if (res.status !== 201)
      throw new Error(`create rule failed: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body as AutomationRuleDto;
  };
  const auditFor = (org = orgId, where: Record<string, unknown> = {}) =>
    t.prisma.auditLog.findMany({
      where: { organizationId: org, ...where },
      orderBy: { createdAt: 'asc' },
    });

  describe('rules: who may do what', () => {
    it.each(ROLES)('%s: every rule operation matches the role', async (role) => {
      const actor = actors[role];
      const allowed = MANAGES.includes(role);
      const existing = await createRule(owner);

      const create = await actor.client.post(
        `/orgs/${orgId}/automation/rules`,
        ruleBody({ name: `by ${role}` }),
      );
      expect(create.status).toBe(allowed ? 201 : 403);
      const responses = await Promise.all([
        actor.client.get(`/orgs/${orgId}/automation/rules`),
        actor.client.get(`/orgs/${orgId}/automation/rules/${existing.id}`),
        actor.client.put(`/orgs/${orgId}/automation/rules/${existing.id}`, ruleBody()),
        actor.client.patch(`/orgs/${orgId}/automation/rules/${existing.id}`, { enabled: false }),
        actor.client.get(`/orgs/${orgId}/automation/rules/${existing.id}/executions`),
      ]);
      for (const res of responses) expect(res.status).toBe(allowed ? 200 : 403);
      const del = await actor.client.delete(`/orgs/${orgId}/automation/rules/${existing.id}`);
      expect(del.status).toBe(allowed ? 204 : 403);
      if (!allowed) {
        // A refused request changed nothing.
        expect(
          (await owner.client.get(`/orgs/${orgId}/automation/rules/${existing.id}`)).body.enabled,
        ).toBe(true);
      }
    });

    it('needs a session', async () => {
      expect(
        (await owner.client.get(`/orgs/${orgId}/automation/rules`, { cookie: null })).status,
      ).toBe(401);
      expect(
        (await owner.client.get(`/orgs/${orgId}/notifications`, { cookie: null })).status,
      ).toBe(401);
    });
  });

  describe('rules: behaviour', () => {
    it('creates, reads, replaces, toggles and deletes a rule', async () => {
      const created = await createRule();
      expect(created).toMatchObject({
        name: 'Critical incident alert',
        trigger: 'incident.created',
        enabled: true,
        cooldownSeconds: 300,
        lastExecutionAt: null,
        lastExecutionStatus: null,
      });
      expect(created.actions[0]).toMatchObject({
        type: 'notify',
        recipients: { roles: ['ADMIN'] },
        body: 'On {{serviceName}}.',
      });

      const replaced = await owner.client.put(
        `/orgs/${orgId}/automation/rules/${created.id}`,
        ruleBody({ name: 'Renamed', conditions: [], cooldownSeconds: 0, enabled: false }),
      );
      expect(replaced.status).toBe(200);
      expect(replaced.body).toMatchObject({
        name: 'Renamed',
        conditions: [],
        cooldownSeconds: 0,
        enabled: false,
      });

      const toggled = await owner.client.patch(`/orgs/${orgId}/automation/rules/${created.id}`, {
        enabled: true,
      });
      expect(toggled.body.enabled).toBe(true);
      const list = await owner.client.get(`/orgs/${orgId}/automation/rules`);
      expect((list.body.data as AutomationRuleDto[]).some((r) => r.id === created.id)).toBe(true);

      expect(
        (await owner.client.delete(`/orgs/${orgId}/automation/rules/${created.id}`)).status,
      ).toBe(204);
      expect((await owner.client.get(`/orgs/${orgId}/automation/rules/${created.id}`)).status).toBe(
        404,
      );
      expect(
        (await owner.client.delete(`/orgs/${orgId}/automation/rules/${created.id}`)).status,
      ).toBe(404);
    });

    it('validates a rule against its trigger, with field-level errors', async () => {
      const bad = async (body: Record<string, unknown>) => {
        const res = await owner.client.post(`/orgs/${orgId}/automation/rules`, body);
        expect(res.status).toBe(400);
        return res.body.error.details as { path: string; message: string }[];
      };
      expect(await bad(ruleBody({ trigger: 'service.exploded' }))).toBeTruthy();
      expect(
        await bad(ruleBody({ conditions: [{ field: 'toHealth', operator: 'eq', value: 'DOWN' }] })),
      ).toEqual([expect.objectContaining({ path: 'conditions.0.field' })]);
      expect(await bad(ruleBody({ actions: [notify({ title: '{{password}}' })] }))).toEqual([
        expect.objectContaining({ path: 'actions.0' }),
      ]);
      expect(
        await bad(ruleBody({ actions: [notify({ recipients: { assignee: true } })] })),
      ).toEqual([expect.objectContaining({ path: 'actions.0.recipients' })]);
      expect(
        await bad(ruleBody({ actions: [{ type: 'shell', command: 'rm -rf /' }] })),
      ).toBeTruthy();
      expect(await bad(ruleBody({ actions: [] }))).toBeTruthy();
      expect(await bad({ name: 'x' })).toBeTruthy();
    });

    it('ignores fields it does not know, instead of storing them', async () => {
      const res = await owner.client.post(`/orgs/${orgId}/automation/rules`, {
        ...ruleBody(),
        organizationId: randomUUID(),
        createdById: randomUUID(),
        actions: [{ ...notify(), evil: 'x' }],
      });
      expect(res.status).toBe(201);
      const row = await t.prisma.automationRule.findUniqueOrThrow({ where: { id: res.body.id } });
      expect(row.organizationId).toBe(orgId); // never taken from the body
      expect(row.createdById).toBe(owner.id); // never taken from the body
      expect(JSON.stringify(row.actions)).not.toContain('evil');
    });

    it('only lets a rule point at things that exist in this organization', async () => {
      const other = await registerUser(t, 'Other Owner');
      const otherOrg = (await createOrg(other, 'Other Org')).id;
      const theirHook = await other.client.post(`/orgs/${otherOrg}/outbound-webhooks`, {
        name: 'theirs',
        url: 'https://hooks.example.com/theirs',
      });
      expect(theirHook.status).toBe(201);
      const ourHook = await owner.client.post(`/orgs/${orgId}/outbound-webhooks`, {
        name: 'ours',
        url: 'https://hooks.example.com/ours',
      });
      const stranger = await registerUser(t, 'Stranger');

      const cases: [string, Record<string, unknown>][] = [
        ['another organization’s webhook', { type: 'webhook', destinationId: theirHook.body.id }],
        ['a webhook that does not exist', { type: 'webhook', destinationId: randomUUID() }],
        ['a person who is not a member', notify({ recipients: { userIds: [stranger.id] } })],
        ['a member of a different organization', notify({ recipients: { userIds: [other.id] } })],
      ];
      for (const [label, action] of cases) {
        const res = await owner.client.post(
          `/orgs/${orgId}/automation/rules`,
          ruleBody({ trigger: 'deployment.failed', conditions: [], actions: [action] }),
        );
        expect(res.status, label).toBe(400);
      }
      // ...but our own webhook and our own member are fine
      const ok = await owner.client.post(
        `/orgs/${orgId}/automation/rules`,
        ruleBody({
          trigger: 'deployment.failed',
          conditions: [],
          actions: [
            { type: 'webhook', destinationId: ourHook.body.id },
            notify({ recipients: { userIds: [actors.DEVELOPER.id] }, title: 'x', body: '' }),
          ],
        }),
      );
      expect(ok.status).toBe(201);
      // a disabled webhook can no longer be chosen
      await owner.client.delete(`/orgs/${orgId}/outbound-webhooks/${ourHook.body.id}`);
      const again = await owner.client.post(
        `/orgs/${orgId}/automation/rules`,
        ruleBody({
          trigger: 'deployment.failed',
          conditions: [],
          actions: [{ type: 'webhook', destinationId: ourHook.body.id }],
        }),
      );
      expect(again.status).toBe(400);
    });

    it('caps the number of rules per organization, even under concurrency', async () => {
      const org = await registerUser(t, 'Cap Owner');
      const capOrg = (await createOrg(org, 'Cap Org')).id;
      await t.prisma.automationRule.createMany({
        data: Array.from({ length: 49 }, (_, i) => ({
          organizationId: capOrg,
          name: `r${i}`,
          trigger: 'incident.created',
          conditions: [],
          actions: [notify()],
        })) as never,
      });
      const results = await Promise.all(
        Array.from({ length: 4 }, () =>
          org.client.post(`/orgs/${capOrg}/automation/rules`, ruleBody()),
        ),
      );
      expect(results.filter((r) => r.status === 201)).toHaveLength(1);
      expect(results.filter((r) => r.status === 409).map((r) => r.body.error.code)).toEqual([
        'RULE_LIMIT',
        'RULE_LIMIT',
        'RULE_LIMIT',
      ]);
      expect(await t.prisma.automationRule.count({ where: { organizationId: capOrg } })).toBe(50);
    });

    it('shows what a rule did, newest first, with each action’s result', async () => {
      const rule = await createRule();
      const event = await t.prisma.domainEvent.create({
        data: { organizationId: orgId, type: 'incident.created', facts: {} },
      });
      const event2 = await t.prisma.domainEvent.create({
        data: { organizationId: orgId, type: 'incident.created', facts: {} },
      });
      await t.prisma.automationExecution.create({
        data: {
          organizationId: orgId,
          ruleId: rule.id,
          eventId: event.id,
          eventType: 'incident.created',
          status: 'SUCCEEDED',
          results: [
            { index: 0, type: 'notify', status: 'SUCCEEDED', detail: 'notified: 2 in-app' },
          ],
          finishedAt: new Date(Date.now() - 5000),
          createdAt: new Date(Date.now() - 10_000),
        },
      });
      await t.prisma.automationExecution.create({
        data: {
          organizationId: orgId,
          ruleId: rule.id,
          eventId: event2.id,
          eventType: 'incident.created',
          status: 'SKIPPED',
          skipReason: 'cooldown',
          finishedAt: new Date(),
        },
      });

      const page = (await owner.client.get(`/orgs/${orgId}/automation/rules/${rule.id}/executions`))
        .body as ExecutionPageDto;
      expect(page.data.map((e) => e.status)).toEqual(['SKIPPED', 'SUCCEEDED']);
      expect(page.data[0]).toMatchObject({ skipReason: 'cooldown', results: [] });
      expect(page.data[1]!.results).toEqual([
        { index: 0, type: 'notify', status: 'SUCCEEDED', detail: 'notified: 2 in-app' },
      ]);
      expect(page.nextBefore).toBeNull();

      const first = (
        await owner.client.get(`/orgs/${orgId}/automation/rules/${rule.id}/executions?limit=1`)
      ).body as ExecutionPageDto;
      expect(first.data).toHaveLength(1);
      expect(first.nextBefore).not.toBeNull();
      const second = (
        await owner.client.get(
          `/orgs/${orgId}/automation/rules/${rule.id}/executions?limit=1&before=${encodeURIComponent(first.nextBefore!)}`,
        )
      ).body as ExecutionPageDto;
      expect(second.data.map((e) => e.status)).toEqual(['SUCCEEDED']);

      // ...and the rule list carries the latest outcome
      const listed = (
        (await owner.client.get(`/orgs/${orgId}/automation/rules`)).body.data as AutomationRuleDto[]
      ).find((r) => r.id === rule.id);
      expect(listed).toMatchObject({ lastExecutionStatus: 'SKIPPED' });
      expect(listed!.lastExecutionAt).not.toBeNull();
      expect(
        (await owner.client.get(`/orgs/${orgId}/automation/rules/${rule.id}/executions?limit=0`))
          .status,
      ).toBe(400);
    });
  });

  describe('tenant isolation', () => {
    it('another organization can neither see nor change our rules, by any path', async () => {
      const mine = await createRule();
      const other = await registerUser(t, 'Tenant B');
      const otherOrg = (await createOrg(other, 'Tenant B Org')).id;
      await createRule(other, otherOrg, { name: 'B rule' });

      // through our organization's path: not a member
      for (const res of await Promise.all([
        other.client.get(`/orgs/${orgId}/automation/rules`),
        other.client.get(`/orgs/${orgId}/automation/rules/${mine.id}`),
        other.client.delete(`/orgs/${orgId}/automation/rules/${mine.id}`),
        other.client.get(`/orgs/${orgId}/notifications`),
        other.client.get(`/orgs/${orgId}/audit-logs`),
        other.client.get(`/orgs/${orgId}/outbound-webhooks`),
      ])) {
        expect(res.status).toBe(404);
      }
      // through their own path, using our rule's id
      for (const res of await Promise.all([
        other.client.get(`/orgs/${otherOrg}/automation/rules/${mine.id}`),
        other.client.put(
          `/orgs/${otherOrg}/automation/rules/${mine.id}`,
          ruleBody({ name: 'hijacked' }),
        ),
        other.client.patch(`/orgs/${otherOrg}/automation/rules/${mine.id}`, { enabled: false }),
        other.client.delete(`/orgs/${otherOrg}/automation/rules/${mine.id}`),
        other.client.get(`/orgs/${otherOrg}/automation/rules/${mine.id}/executions`),
      ])) {
        expect(res.status).toBe(404);
      }
      const still = await t.prisma.automationRule.findUniqueOrThrow({ where: { id: mine.id } });
      expect(still).toMatchObject({
        name: 'Critical incident alert',
        enabled: true,
        organizationId: orgId,
      });
      // their list only ever shows their own
      const theirs = (await other.client.get(`/orgs/${otherOrg}/automation/rules`)).body
        .data as AutomationRuleDto[];
      expect(theirs.map((r) => r.name)).toEqual(['B rule']);
    });
  });

  describe('the audit log', () => {
    it('records who did what, once per change, in the same transaction, and nothing for a refused one', async () => {
      const org = await registerUser(t, 'Audited Owner');
      const auditOrg = (await createOrg(org, 'Audit Org')).id;
      const before = (await auditFor(auditOrg)).length;

      const rule = await createRule(org, auditOrg, { name: 'Audited rule' });
      await org.client.put(
        `/orgs/${auditOrg}/automation/rules/${rule.id}`,
        ruleBody({ name: 'Audited rule v2' }),
      );
      await org.client.patch(`/orgs/${auditOrg}/automation/rules/${rule.id}`, { enabled: false });
      await org.client.patch(`/orgs/${auditOrg}/automation/rules/${rule.id}`, { enabled: false }); // no change: no entry
      await org.client.patch(`/orgs/${auditOrg}/automation/rules/${rule.id}`, { enabled: true });
      await org.client.delete(`/orgs/${auditOrg}/automation/rules/${rule.id}`);
      await org.client.post(`/orgs/${auditOrg}/automation/rules`, ruleBody({ trigger: 'nope' })); // refused: no entry

      const entries = (await auditFor(auditOrg)).slice(before);
      expect(entries.map((e) => e.action)).toEqual([
        'automation.rule.created',
        'automation.rule.updated',
        'automation.rule.disabled',
        'automation.rule.enabled',
        'automation.rule.deleted',
      ]);
      expect(
        entries.every(
          (e) => e.actorType === 'USER' && e.actorId === org.id && e.actorLabel === 'Audited Owner',
        ),
      ).toBe(true);
      expect(
        entries.every((e) => e.resourceId === rule.id && e.resourceType === 'automation_rule'),
      ).toBe(true);
      expect(entries.every((e) => typeof e.requestId === 'string' && e.requestId.length > 0)).toBe(
        true,
      );
      expect(entries[0]!.metadata).toEqual({
        name: 'Audited rule',
        trigger: 'incident.created',
        enabled: true,
        actions: ['notify'],
      });
      expect(entries[4]!.metadata).toEqual({
        name: 'Audited rule v2',
        trigger: 'incident.created',
      });
    });

    it('never puts a secret or a URL query string in the log', async () => {
      const org = await registerUser(t, 'Secret Owner');
      const secretOrg = (await createOrg(org, 'Secret Org')).id;
      const hook = await org.client.post(`/orgs/${secretOrg}/outbound-webhooks`, {
        name: 'Pager',
        url: 'https://hooks.example.com/path?token=SUPERSECRETTOKEN',
      });
      expect(hook.status).toBe(201);
      const project = await createProject(org, secretOrg);
      const gh = await org.client.post(`/orgs/${secretOrg}/integrations/github`, {
        repoFullName: 'acme/audit-me',
        projectId: project.id,
      });
      expect(gh.status).toBe(201);
      await org.client.delete(`/orgs/${secretOrg}/integrations/github/${gh.body.id}`);
      await org.client.delete(`/orgs/${secretOrg}/outbound-webhooks/${hook.body.id}`);

      const entries = await auditFor(secretOrg);
      expect(entries.map((e) => e.action)).toEqual([
        'outbound_webhook.created',
        'project.created', // creating the project for the integration is audited too (Phase 10)
        'integration.github.created',
        'integration.github.disabled',
        'outbound_webhook.disabled',
      ]);
      const everything = JSON.stringify(entries);
      expect(everything).not.toContain('SUPERSECRETTOKEN');
      expect(everything).not.toContain(hook.body.signingSecret);
      expect(everything).not.toContain(gh.body.webhookSecret);
      expect(entries[0]!.metadata).toEqual({
        name: 'Pager',
        url: 'https://hooks.example.com/path',
      });
      expect(entries[2]!.metadata).toEqual({ repository: 'acme/audit-me' });
    });

    it.each(ROLES)('%s: reading the audit log matches the role', async (role) => {
      const res = await actors[role].client.get(`/orgs/${orgId}/audit-logs`);
      expect(res.status).toBe(MANAGES.includes(role) ? 200 : 403);
    });

    it('is read-only over HTTP, filterable and paged, and never shows another organization’s entries', async () => {
      const org = await registerUser(t, 'Reader Owner');
      const readerOrg = (await createOrg(org, 'Reader Org')).id;
      for (let i = 0; i < 3; i += 1) {
        const rule = await createRule(org, readerOrg, { name: `R${i}` });
        if (i === 0) await org.client.delete(`/orgs/${readerOrg}/automation/rules/${rule.id}`);
      }
      const all = (await org.client.get(`/orgs/${readerOrg}/audit-logs`)).body as AuditLogPageDto;
      expect(all.data.map((e) => e.action)).toEqual([
        'automation.rule.created',
        'automation.rule.created',
        'automation.rule.deleted',
        'automation.rule.created',
      ]);
      expect(all.data.every((e) => !('organizationId' in e))).toBe(true);

      const deletes = (
        await org.client.get(`/orgs/${readerOrg}/audit-logs?action=automation.rule.deleted`)
      ).body as AuditLogPageDto;
      expect(deletes.data).toHaveLength(1);
      expect(
        (await org.client.get(`/orgs/${readerOrg}/audit-logs?action=not.an.action`)).status,
      ).toBe(400);

      const page1 = (await org.client.get(`/orgs/${readerOrg}/audit-logs?limit=3`))
        .body as AuditLogPageDto;
      expect(page1.data).toHaveLength(3);
      const page2 = (
        await org.client.get(
          `/orgs/${readerOrg}/audit-logs?limit=3&before=${encodeURIComponent(page1.nextBefore!)}`,
        )
      ).body as AuditLogPageDto;
      expect(page2.data).toHaveLength(1);
      expect(page2.nextBefore).toBeNull();

      // nothing writes to it over HTTP
      for (const method of ['post', 'put', 'patch', 'delete'] as const) {
        const res = await org.client.send(method, `/orgs/${readerOrg}/audit-logs`, { body: {} });
        expect(res.status, method).toBeGreaterThanOrEqual(400);
      }
      // the log of one organization never contains another's entries
      expect(JSON.stringify(all)).not.toContain(orgId);
    });
  });

  describe('outbound webhooks', () => {
    it('returns the signing secret once and stores it encrypted', async () => {
      const created = await owner.client.post(`/orgs/${orgId}/outbound-webhooks`, {
        name: 'Pager',
        url: 'https://hooks.example.com/hook?token=abc',
      });
      expect(created.status).toBe(201);
      const body = created.body as CreatedOutboundWebhookDto;
      expect(body.signingSecret).toMatch(/^[0-9a-f]{64}$/);
      expect(body.url).toBe('https://hooks.example.com/hook'); // no query string, ever
      expect(body.enabled).toBe(true);

      const list = await owner.client.get(`/orgs/${orgId}/outbound-webhooks`);
      const listed = (list.body.data as Record<string, unknown>[]).find((h) => h.id === body.id)!;
      expect(listed).not.toHaveProperty('signingSecret');
      expect(JSON.stringify(list.body)).not.toContain(body.signingSecret);
      expect(JSON.stringify(list.body)).not.toContain('token=abc');

      const row = await t.prisma.outboundWebhook.findUniqueOrThrow({ where: { id: body.id } });
      expect(row.secretEncrypted).not.toContain(body.signingSecret);
      expect(decryptSecret(row.secretEncrypted, Buffer.from(KEY, 'base64'), body.id)).toBe(
        body.signingSecret,
      );
    });

    it('refuses private and unsafe destinations (the same rules as monitoring)', async () => {
      for (const url of [
        'http://127.0.0.1/hook',
        'http://localhost/hook',
        'http://169.254.169.254/latest',
        'https://user:pass@hooks.example.com/x',
        'ftp://hooks.example.com/x',
        'not a url',
      ]) {
        const res = await owner.client.post(`/orgs/${orgId}/outbound-webhooks`, {
          name: 'Bad',
          url,
        });
        expect(res.status, url).toBe(400);
        if (url !== 'not a url') expect(res.body.error.code).toBe('URL_NOT_ALLOWED');
      }
    });

    it.each(ROLES)('%s: managing destinations matches the role', async (role) => {
      const actor = actors[role];
      const allowed = MANAGES.includes(role);
      const create = await actor.client.post(`/orgs/${orgId}/outbound-webhooks`, {
        name: `by ${role}`,
        url: 'https://hooks.example.com/x',
      });
      expect(create.status).toBe(allowed ? 201 : 403);
      expect((await actor.client.get(`/orgs/${orgId}/outbound-webhooks`)).status).toBe(
        allowed ? 200 : 403,
      );
      const target = (
        await owner.client.post(`/orgs/${orgId}/outbound-webhooks`, {
          name: 'target',
          url: 'https://hooks.example.com/t',
        })
      ).body;
      expect(
        (await actor.client.delete(`/orgs/${orgId}/outbound-webhooks/${target.id}`)).status,
      ).toBe(allowed ? 204 : 403);
    });

    it('disables a destination once, limits how many there can be, and validates the body', async () => {
      const org = await registerUser(t, 'Hook Owner');
      const hookOrg = (await createOrg(org, 'Hook Org')).id;
      const first = await org.client.post(`/orgs/${hookOrg}/outbound-webhooks`, {
        name: 'One',
        url: 'https://hooks.example.com/1',
      });
      expect(
        (await org.client.delete(`/orgs/${hookOrg}/outbound-webhooks/${first.body.id}`)).status,
      ).toBe(204);
      expect(
        (await org.client.delete(`/orgs/${hookOrg}/outbound-webhooks/${first.body.id}`)).status,
      ).toBe(404);
      expect(
        ((await org.client.get(`/orgs/${hookOrg}/outbound-webhooks`)).body.data as unknown[])
          .length,
      ).toBe(0);

      const results = [];
      for (let i = 0; i < 11; i += 1)
        results.push(
          await org.client.post(`/orgs/${hookOrg}/outbound-webhooks`, {
            name: `H${i}`,
            url: `https://hooks.example.com/${i}`,
          }),
        );
      expect(results.filter((r) => r.status === 201)).toHaveLength(10);
      expect(results.at(-1)!.body.error.code).toBe('WEBHOOK_LIMIT');
      expect(
        (
          await org.client.post(`/orgs/${hookOrg}/outbound-webhooks`, {
            name: '',
            url: 'https://hooks.example.com/x',
          })
        ).status,
      ).toBe(400);
      expect((await org.client.post(`/orgs/${hookOrg}/outbound-webhooks`, {})).status).toBe(400);
    });

    it('cannot disable another organization’s destination', async () => {
      const other = await registerUser(t, 'Hook Tenant B');
      const otherOrg = (await createOrg(other, 'Hook B Org')).id;
      const theirs = await other.client.post(`/orgs/${otherOrg}/outbound-webhooks`, {
        name: 'B',
        url: 'https://hooks.example.com/b',
      });
      expect(
        (await owner.client.delete(`/orgs/${orgId}/outbound-webhooks/${theirs.body.id}`)).status,
      ).toBe(404);
      expect(
        (await t.prisma.outboundWebhook.findUniqueOrThrow({ where: { id: theirs.body.id } }))
          .enabled,
      ).toBe(true);
    });

    it('is disabled with a clear error while INTEGRATION_ENCRYPTION_KEY is not set', async () => {
      const bare = await createTestApp({ env: { INTEGRATION_ENCRYPTION_KEY: '' } });
      try {
        const user = await registerUser(bare, 'No Key');
        const org = (await createOrg(user, 'No Key Org')).id;
        const res = await user.client.post(`/orgs/${org}/outbound-webhooks`, {
          name: 'x',
          url: 'https://hooks.example.com/x',
        });
        expect(res.status).toBe(503);
        expect(res.body.error.code).toBe('INTEGRATIONS_NOT_CONFIGURED');
      } finally {
        await bare.close();
      }
    });
  });

  describe('notifications: everyone sees only their own', () => {
    const add = (org: string, userId: string, over: Record<string, unknown> = {}) =>
      t.prisma.notification.create({
        data: {
          organizationId: org,
          userId,
          type: 'incident.created',
          title: 'Hello',
          body: 'b',
          link: `/orgs/${org}/incidents/${randomUUID()}`,
          ...over,
        } as never,
      });

    it('lists my in-app notifications only, newest first, with an unread count', async () => {
      const org = await registerUser(t, 'Inbox Owner');
      const inboxOrg = (await createOrg(org, 'Inbox Org')).id;
      const member = await userWithRole(t, inboxOrg, 'VIEWER');
      await add(inboxOrg, org.id, { title: 'older', createdAt: new Date(Date.now() - 60_000) });
      await add(inboxOrg, org.id, { title: 'newer' });
      await add(inboxOrg, org.id, { title: 'read one', readAt: new Date() });
      await add(inboxOrg, org.id, { title: 'email only', inApp: false });
      await add(inboxOrg, member.id, { title: 'the member’s' });

      const mine = (await org.client.get(`/orgs/${inboxOrg}/notifications`))
        .body as NotificationPageDto;
      expect(mine.data.map((n) => n.title)).toEqual(['read one', 'newer', 'older']);
      expect(mine.unreadCount).toBe(2);
      expect(JSON.stringify(mine)).not.toContain('the member’s');
      expect(JSON.stringify(mine)).not.toContain('email only');
      expect(mine.data[0]).toMatchObject({ type: 'incident.created', body: 'b' });
      expect(mine.data[0]!.link).toMatch(new RegExp(`^/orgs/${inboxOrg}/incidents/`));

      const unread = (await org.client.get(`/orgs/${inboxOrg}/notifications?unread=true`))
        .body as NotificationPageDto;
      expect(unread.data.map((n) => n.title)).toEqual(['newer', 'older']);
      expect((await org.client.get(`/orgs/${inboxOrg}/notifications/unread-count`)).body).toEqual({
        count: 2,
      });

      // every role can read its own inbox
      const theirs = (await member.client.get(`/orgs/${inboxOrg}/notifications`))
        .body as NotificationPageDto;
      expect(theirs.data.map((n) => n.title)).toEqual(['the member’s']);
    });

    it('marks only my own notifications read, and cannot touch anyone else’s', async () => {
      const org = await registerUser(t, 'Reader');
      const readOrg = (await createOrg(org, 'Read Org')).id;
      const other = await userWithRole(t, readOrg, 'DEVELOPER');
      const mine = await add(readOrg, org.id);
      const theirs = await add(readOrg, other.id);

      expect(
        (await org.client.post(`/orgs/${readOrg}/notifications/${theirs.id}/read`)).status,
      ).toBe(404);
      expect(
        (await t.prisma.notification.findUniqueOrThrow({ where: { id: theirs.id } })).readAt,
      ).toBeNull();
      expect((await org.client.post(`/orgs/${readOrg}/notifications/${mine.id}/read`)).status).toBe(
        204,
      );
      expect((await org.client.post(`/orgs/${readOrg}/notifications/${mine.id}/read`)).status).toBe(
        204,
      ); // idempotent
      expect(
        (await t.prisma.notification.findUniqueOrThrow({ where: { id: mine.id } })).readAt,
      ).not.toBeNull();
      expect(
        (await org.client.post(`/orgs/${readOrg}/notifications/${randomUUID()}/read`)).status,
      ).toBe(404);
      expect((await org.client.post(`/orgs/${readOrg}/notifications/not-a-uuid/read`)).status).toBe(
        404,
      );

      await add(readOrg, org.id);
      await add(readOrg, org.id);
      expect((await org.client.post(`/orgs/${readOrg}/notifications/read-all`)).body).toEqual({
        updated: 2,
      });
      expect(
        (await t.prisma.notification.findUniqueOrThrow({ where: { id: theirs.id } })).readAt,
      ).toBeNull(); // still unread
      expect((await other.client.get(`/orgs/${readOrg}/notifications/unread-count`)).body).toEqual({
        count: 1,
      });
    });

    it('cannot be read across organizations, even by someone who is a member of both', async () => {
      const a = await registerUser(t, 'Two Orgs');
      const orgA = (await createOrg(a, 'Org A')).id;
      const b = await registerUser(t, 'Org B Owner');
      const orgB = (await createOrg(b, 'Org B')).id;
      await t.prisma.organizationMember.create({
        data: { organizationId: orgB, userId: a.id, role: 'VIEWER' },
      });
      await add(orgA, a.id, { title: 'in A' });
      await add(orgB, a.id, { title: 'in B' });

      expect(
        ((await a.client.get(`/orgs/${orgA}/notifications`)).body as NotificationPageDto).data.map(
          (n) => n.title,
        ),
      ).toEqual(['in A']);
      expect(
        ((await a.client.get(`/orgs/${orgB}/notifications`)).body as NotificationPageDto).data.map(
          (n) => n.title,
        ),
      ).toEqual(['in B']);
      // b is not the recipient of anything
      expect(
        ((await b.client.get(`/orgs/${orgB}/notifications`)).body as NotificationPageDto).data,
      ).toEqual([]);
    });

    it('pages by timestamp and rejects a bad query', async () => {
      const org = await registerUser(t, 'Pager');
      const pageOrg = (await createOrg(org, 'Page Org')).id;
      for (let i = 0; i < 5; i += 1)
        await add(pageOrg, org.id, { title: `n${i}`, createdAt: new Date(Date.now() - i * 1000) });
      const first = (await org.client.get(`/orgs/${pageOrg}/notifications?limit=2`))
        .body as NotificationPageDto;
      expect(first.data.map((n) => n.title)).toEqual(['n0', 'n1']);
      const second = (
        await org.client.get(
          `/orgs/${pageOrg}/notifications?limit=2&before=${encodeURIComponent(first.nextBefore!)}`,
        )
      ).body as NotificationPageDto;
      expect(second.data.map((n) => n.title)).toEqual(['n2', 'n3']);
      for (const q of ['limit=0', 'limit=1000', 'before=yesterday', 'unread=maybe']) {
        expect((await org.client.get(`/orgs/${pageOrg}/notifications?${q}`)).status, q).toBe(400);
      }
    });
  });
});
