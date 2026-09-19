import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPrismaClient } from './index';

// Requires PostgreSQL with migrations applied. These tests go straight to the database, bypassing
// every line of application code: they prove what the DATABASE guarantees on its own.
const url = process.env.DATABASE_URL;

const TRIGGER = 'incident.created';
const RULE_ACTIONS = [
  {
    type: 'notify',
    recipients: { roles: ['ADMIN'] },
    channels: ['in_app'],
    title: 'x',
    body: '',
  },
];

describe.skipIf(!url)('automation schema (integration)', () => {
  const prisma = createPrismaClient(url ?? 'postgresql://unused');
  afterAll(() => prisma.$disconnect());

  interface Tenant {
    orgId: string;
    userId: string;
    ruleId: string;
    eventId: string;
  }

  async function tenant(): Promise<Tenant> {
    const suffix = randomUUID().slice(0, 8);
    const org = await prisma.organization.create({
      data: { name: `Org ${suffix}`, slug: `org-${suffix}` },
    });
    const user = await prisma.user.create({
      data: {
        email: `u-${suffix}@example.com`,
        name: 'U',
        passwordHash: '$argon2id$test-only-not-a-real-hash',
      },
    });
    await prisma.organizationMember.create({
      data: { organizationId: org.id, userId: user.id, role: 'ADMIN' },
    });
    const rule = await prisma.automationRule.create({
      data: {
        organizationId: org.id,
        name: 'Rule',
        trigger: TRIGGER,
        conditions: [],
        actions: RULE_ACTIONS,
      },
    });
    const event = await prisma.domainEvent.create({
      data: { organizationId: org.id, type: TRIGGER, facts: { severity: 'SEV1' } },
    });
    return { orgId: org.id, userId: user.id, ruleId: rule.id, eventId: event.id };
  }

  let a: Tenant;
  let b: Tenant;
  beforeAll(async () => {
    a = await tenant();
    b = await tenant();
  });

  const execution = (t: Tenant, over: Record<string, unknown> = {}) =>
    prisma.automationExecution.create({
      data: {
        organizationId: t.orgId,
        ruleId: t.ruleId,
        eventId: t.eventId,
        eventType: TRIGGER,
        ...over,
      } as never,
    });

  describe('tenant isolation, enforced by composite foreign keys', () => {
    it('an execution cannot join a rule of one organization to an event of another', async () => {
      await expect(execution(a, { eventId: b.eventId })).rejects.toThrow();
      await expect(execution(a, { ruleId: b.ruleId })).rejects.toThrow();
      await expect(execution(a)).resolves.toBeDefined(); // the same organization is fine
    });

    it('a notification can only exist for a member of its own organization', async () => {
      const base = { type: TRIGGER, title: 'Hello' };
      // b's user is not a member of a's organization
      await expect(
        prisma.notification.create({
          data: { ...base, organizationId: a.orgId, userId: b.userId },
        }),
      ).rejects.toThrow();
      await expect(
        prisma.notification.create({
          data: { ...base, organizationId: a.orgId, userId: a.userId },
        }),
      ).resolves.toBeDefined();
    });

    it('removing a member removes their notifications with them', async () => {
      const t = await tenant();
      await prisma.notification.create({
        data: { type: TRIGGER, title: 'Bye', organizationId: t.orgId, userId: t.userId },
      });
      await prisma.organizationMember.deleteMany({
        where: { organizationId: t.orgId, userId: t.userId },
      });
      expect(await prisma.notification.count({ where: { organizationId: t.orgId } })).toBe(0);
    });
  });

  describe('idempotency', () => {
    it('a rule can run at most once per event', async () => {
      const t = await tenant();
      await execution(t);
      await expect(execution(t)).rejects.toMatchObject({ code: 'P2002' });
      expect(await prisma.automationExecution.count({ where: { ruleId: t.ruleId } })).toBe(1);
    });

    it('a retried action cannot notify the same person twice', async () => {
      const t = await tenant();
      const executionId = randomUUID();
      const note = () =>
        prisma.notification.create({
          data: {
            type: TRIGGER,
            title: 'Once',
            organizationId: t.orgId,
            userId: t.userId,
            executionId,
            actionIndex: 0,
          },
        });
      await note();
      await expect(note()).rejects.toMatchObject({ code: 'P2002' });
      // a different action of the same execution is a different notification
      await expect(
        prisma.notification.create({
          data: {
            type: TRIGGER,
            title: 'Twice',
            organizationId: t.orgId,
            userId: t.userId,
            executionId,
            actionIndex: 1,
          },
        }),
      ).resolves.toBeDefined();
    });
  });

  describe('the audit log is append-only', () => {
    async function entry() {
      return prisma.auditLog.create({
        data: {
          organizationId: a.orgId,
          actorType: 'USER',
          actorId: a.userId,
          actorLabel: 'U',
          action: 'automation.rule.created',
          resourceType: 'automation_rule',
          resourceId: a.ruleId,
          metadata: { name: 'Rule' },
        },
      });
    }

    it('accepts inserts and refuses UPDATE, DELETE and TRUNCATE, even through raw SQL', async () => {
      const row = await entry();
      await expect(
        prisma.auditLog.update({ where: { id: row.id }, data: { action: 'tampered' } }),
      ).rejects.toThrow(/append-only/);
      await expect(prisma.auditLog.delete({ where: { id: row.id } })).rejects.toThrow(
        /append-only/,
      );
      await expect(
        prisma.auditLog.deleteMany({ where: { organizationId: a.orgId } }),
      ).rejects.toThrow(/append-only/);
      await expect(prisma.$executeRawUnsafe('TRUNCATE "AuditLog"')).rejects.toThrow(/append-only/);
      await expect(
        prisma.$executeRawUnsafe(`UPDATE "AuditLog" SET "actorLabel" = 'x' WHERE id = '${row.id}'`),
      ).rejects.toThrow(/append-only/);
      expect((await prisma.auditLog.findUniqueOrThrow({ where: { id: row.id } })).action).toBe(
        'automation.rule.created',
      );
    });

    it('cannot be silently emptied by deleting the organization', async () => {
      const t = await tenant();
      await prisma.auditLog.create({
        data: {
          organizationId: t.orgId,
          actorType: 'SYSTEM',
          actorLabel: 'NEXUS',
          action: 'automation.rule.created',
          resourceType: 'automation_rule',
        },
      });
      await expect(prisma.organization.delete({ where: { id: t.orgId } })).rejects.toThrow();
    });
  });

  describe('value constraints', () => {
    it.each([
      ['an unknown trigger', { trigger: 'incident.exploded' }],
      ['a cooldown that is too long', { cooldownSeconds: 86_401 }],
      ['a negative cooldown', { cooldownSeconds: -1 }],
      ['no actions', { actions: [] }],
      ['too many actions', { actions: Array.from({ length: 6 }, () => RULE_ACTIONS[0]) }],
      ['conditions that are not a list', { conditions: {} }],
      ['an empty name', { name: '' }],
    ])('a rule with %s is refused', async (_label, over) => {
      await expect(
        prisma.automationRule.create({
          data: {
            organizationId: a.orgId,
            name: 'R',
            trigger: TRIGGER,
            conditions: [],
            actions: RULE_ACTIONS,
            ...over,
          } as never,
        }),
      ).rejects.toThrow();
    });

    it('an event of an unknown type, or with non-object facts, is refused', async () => {
      await expect(
        prisma.domainEvent.create({ data: { organizationId: a.orgId, type: 'nope', facts: {} } }),
      ).rejects.toThrow();
      await expect(
        prisma.domainEvent.create({ data: { organizationId: a.orgId, type: TRIGGER, facts: [] } }),
      ).rejects.toThrow();
    });

    it('notification links must be in-app paths, never arbitrary URLs', async () => {
      const make = (link: string | null) =>
        prisma.notification.create({
          data: { type: TRIGGER, title: 'L', link, organizationId: a.orgId, userId: a.userId },
        });
      for (const bad of [
        'https://evil.example',
        '//evil.example',
        'javascript:alert(1)',
        '/etc/passwd',
      ]) {
        await expect(make(bad), bad).rejects.toThrow();
      }
      await expect(make(`/orgs/${a.orgId}/incidents/${randomUUID()}`)).resolves.toBeDefined();
      await expect(make(null)).resolves.toBeDefined();
    });

    it('outbound webhooks must be http(s) with a stored secret', async () => {
      const make = (url: string, secretEncrypted = 'v1:x') =>
        prisma.outboundWebhook.create({
          data: { organizationId: a.orgId, name: 'W', url, secretEncrypted },
        });
      await expect(make('ftp://example.com/hook')).rejects.toThrow();
      await expect(make('javascript:alert(1)')).rejects.toThrow();
      await expect(make('https://example.com/hook', '')).rejects.toThrow();
      await expect(make('https://example.com/hook')).resolves.toBeDefined();
    });

    it('a skip reason is only allowed on a skipped execution', async () => {
      const t = await tenant();
      await expect(execution(t, { status: 'SUCCEEDED', skipReason: 'cooldown' })).rejects.toThrow();
      await expect(
        execution(t, { status: 'SKIPPED', skipReason: 'cooldown' }),
      ).resolves.toBeDefined();
    });
  });

  it('keeps the undispatched-events scan on a partial index', async () => {
    const rows = await prisma.$queryRaw<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes WHERE indexname = 'DomainEvent_undispatched_idx'`;
    expect(rows[0]?.indexdef).toContain('WHERE ("dispatchedAt" IS NULL)');
  });
});
