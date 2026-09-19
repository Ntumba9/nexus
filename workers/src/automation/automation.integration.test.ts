import { randomUUID } from 'node:crypto';
import { createIncidentRecord, emitDomainEvent, type PrismaClient } from '@nexus/database';
import {
  createRuleSchema,
  type AutomationJobPayload,
  type AutomationTrigger,
  type CreateRuleInput,
  type Role,
} from '@nexus/shared';
import type { JobsOptions } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLogger } from '../logger';
import { HAS_DB, seedService, testPrisma } from '../testing/db';
import { dispatchDomainEvents, enqueueStalePending, type AutomationQueue } from './dispatcher';
import { EmailError, type EmailMessage, type EmailSender } from './email';
import { processExecution } from './executor';
import { cleanupOldAutomationData, cleanupOldNotifications } from './maintenance';

const logger = createLogger('silent');
const WEB = 'https://nexus.example.com';

class RecordingQueue implements AutomationQueue {
  jobs: { data: AutomationJobPayload; options: JobsOptions }[] = [];
  failing = false;
  async add(_name: string, data: AutomationJobPayload, options: JobsOptions): Promise<void> {
    if (this.failing) throw new Error('redis is down');
    this.jobs.push({ data, options });
  }
  forOrg(organizationId: string) {
    return this.jobs.filter((job) => job.data.organizationId === organizationId);
  }
}

class FakeEmail implements EmailSender {
  sent: EmailMessage[] = [];
  failFor = new Map<string, EmailError>();
  async send(message: EmailMessage): Promise<void> {
    const failure = this.failFor.get(message.to);
    if (failure) throw failure;
    this.sent.push(message);
  }
}

const notifyRule = (over: Record<string, unknown> = {}): CreateRuleInput =>
  createRuleSchema.parse({
    name: 'Critical incident alert',
    trigger: 'incident.created',
    conditions: [{ field: 'severity', operator: 'in', value: ['SEV1', 'SEV2'] }],
    actions: [
      {
        type: 'notify',
        recipients: { roles: ['OWNER', 'ADMIN'] },
        channels: ['in_app'],
        title: '{{severity}} incident INC-{{number}}: {{title}}',
        body: 'On {{serviceName}}.',
      },
    ],
    cooldownSeconds: 0,
    ...over,
  });

describe.skipIf(!HAS_DB)('automation engine (integration)', () => {
  let prisma: PrismaClient;
  beforeAll(() => {
    prisma = testPrisma();
  });
  afterAll(() => prisma.$disconnect());

  /** A fresh organization with one user per role (plus a disabled admin), a project and a service. */
  async function tenant() {
    const base = await seedService(prisma, 'Checkout API');
    const users = {} as Record<string, { id: string; email: string }>;
    const suffix = randomUUID().slice(0, 8);
    for (const role of ['OWNER', 'ADMIN', 'DEVELOPER', 'VIEWER'] as Role[]) {
      const email = `${role.toLowerCase()}-${suffix}@example.com`;
      const user = await prisma.user.create({
        data: { email, name: `${role} User`, passwordHash: '$argon2id$test-only-not-a-real-hash' },
      });
      await prisma.organizationMember.create({
        data: { organizationId: base.organizationId, userId: user.id, role },
      });
      users[role] = { id: user.id, email };
    }
    const disabled = await prisma.user.create({
      data: {
        email: `disabled-${suffix}@example.com`,
        name: 'Disabled Admin',
        passwordHash: '$argon2id$test-only-not-a-real-hash',
        disabledAt: new Date(),
      },
    });
    await prisma.organizationMember.create({
      data: { organizationId: base.organizationId, userId: disabled.id, role: 'ADMIN' },
    });

    const orgId = base.organizationId;
    const addRule = (rule: CreateRuleInput) =>
      prisma.automationRule.create({
        data: {
          organizationId: orgId,
          name: rule.name,
          trigger: rule.trigger,
          conditions: rule.conditions as never,
          actions: rule.actions as never,
          enabled: rule.enabled,
          cooldownSeconds: rule.cooldownSeconds,
        },
      });
    const emit = (
      type: AutomationTrigger,
      facts: Record<string, unknown>,
      over: { subjectId?: string | null; causedByExecutionId?: string | null } = {},
    ) =>
      prisma.$transaction((tx) =>
        emitDomainEvent(tx, {
          organizationId: orgId,
          type,
          subjectId: over.subjectId === undefined ? randomUUID() : over.subjectId,
          facts,
          causedByExecutionId: over.causedByExecutionId ?? null,
        }),
      );
    const dispatch = (queue: AutomationQueue, max = 60, batchSize?: number) =>
      dispatchDomainEvents(prisma, queue, logger, {
        maxExecutionsPerRulePerHour: max,
        organizationId: orgId,
        batchSize,
      });
    const executions = () =>
      prisma.automationExecution.findMany({
        where: { organizationId: orgId },
        orderBy: { createdAt: 'asc' },
      });
    const notifications = () =>
      prisma.notification.findMany({
        where: { organizationId: orgId },
        orderBy: { createdAt: 'asc' },
      });
    return {
      ...base,
      orgId,
      users,
      disabledId: disabled.id,
      addRule,
      emit,
      dispatch,
      executions,
      notifications,
    };
  }

  const incidentFacts = (over: Record<string, unknown> = {}) => ({
    incidentId: randomUUID(),
    number: 7,
    title: 'Checkout is down',
    severity: 'SEV1',
    status: 'OPEN',
    source: 'MANUAL',
    serviceId: null,
    serviceName: 'Checkout API',
    ...over,
  });

  const run = (
    t: { orgId: string },
    executionId: string,
    email: EmailSender = new FakeEmail(),
    isFinalAttempt = true,
  ) =>
    processExecution(
      { prisma, logger, email, webOrigin: WEB },
      { executionId, organizationId: t.orgId },
      { isFinalAttempt },
    );

  describe('the dispatcher', () => {
    it('records one PENDING execution per matching rule, enqueues it once, and marks the event done', async () => {
      const t = await tenant();
      const rule = await t.addRule(notifyRule());
      const other = await t.addRule(notifyRule({ name: 'Second rule' }));
      const eventId = await t.emit('incident.created', incidentFacts());
      const queue = new RecordingQueue();

      expect(await t.dispatch(queue)).toEqual({ events: 1, executions: 2, skipped: 0 });

      const found = await t.executions();
      expect(found.map((e) => e.ruleId).sort()).toEqual([rule.id, other.id].sort());
      expect(found.every((e) => e.status === 'PENDING' && e.eventId === eventId)).toBe(true);
      expect(
        queue
          .forOrg(t.orgId)
          .map((j) => j.data.executionId)
          .sort(),
      ).toEqual(found.map((e) => e.id).sort());
      expect(queue.jobs[0]!.options.jobId).toBe(`ax-${queue.jobs[0]!.data.executionId}`);
      const event = await prisma.domainEvent.findUniqueOrThrow({ where: { id: eventId } });
      expect(event.dispatchedAt).not.toBeNull();
    });

    it('ignores rules whose conditions do not match, disabled rules and other triggers', async () => {
      const t = await tenant();
      await t.addRule(
        notifyRule({ conditions: [{ field: 'severity', operator: 'eq', value: 'SEV4' }] }),
      );
      await t.addRule(notifyRule({ name: 'Off', enabled: false }));
      await t.addRule(
        notifyRule({
          name: 'Other',
          trigger: 'incident.assigned',
          conditions: [],
          actions: [
            { type: 'notify', recipients: { roles: ['ADMIN'] }, channels: ['in_app'], title: 'x' },
          ],
        }),
      );
      await t.emit('incident.created', incidentFacts({ severity: 'SEV1' }));
      const queue = new RecordingQueue();
      expect(await t.dispatch(queue)).toEqual({ events: 1, executions: 0, skipped: 0 });
      expect(queue.jobs).toEqual([]);
    });

    it('never lets one organization’s rules react to another organization’s events', async () => {
      const a = await tenant();
      const b = await tenant();
      await b.addRule(notifyRule({ name: 'B rule' }));
      await a.emit('incident.created', incidentFacts());
      const queue = new RecordingQueue();
      await a.dispatch(queue);
      await b.dispatch(queue);
      expect(await a.executions()).toEqual([]);
      expect(queue.jobs).toEqual([]);
      // and b's own event still reaches b's rule
      await b.emit('incident.created', incidentFacts());
      await b.dispatch(queue);
      expect(await b.executions()).toHaveLength(1);
    });

    it('handles an event exactly once, even with several dispatchers running at once', async () => {
      const t = await tenant();
      await t.addRule(notifyRule());
      for (let i = 0; i < 12; i += 1)
        await t.emit('incident.created', incidentFacts({ number: i }));
      const queue = new RecordingQueue();
      const results = await Promise.all(Array.from({ length: 5 }, () => t.dispatch(queue, 60, 4)));
      // drain what the concurrent runs left behind
      while ((await t.dispatch(queue, 60, 4)).events > 0) {
        /* keep going */
      }
      expect(results.reduce((n, r) => n + r.events, 0)).toBeLessThanOrEqual(12);
      const found = await t.executions();
      expect(found).toHaveLength(12);
      expect(new Set(found.map((e) => e.eventId)).size).toBe(12);
      expect(queue.forOrg(t.orgId)).toHaveLength(12);
      expect(new Set(queue.jobs.map((j) => j.data.executionId)).size).toBe(12);
    });

    it('does nothing the second time', async () => {
      const t = await tenant();
      await t.addRule(notifyRule());
      await t.emit('incident.created', incidentFacts());
      const queue = new RecordingQueue();
      await t.dispatch(queue);
      expect(await t.dispatch(queue)).toEqual({ events: 0, executions: 0, skipped: 0 });
      expect(await t.executions()).toHaveLength(1);
      expect(queue.jobs).toHaveLength(1);
    });

    it('records a skipped execution for a repeat within the cooldown, but not for another subject', async () => {
      const t = await tenant();
      await t.addRule(notifyRule({ cooldownSeconds: 600 }));
      const subject = randomUUID();
      await t.emit('incident.created', incidentFacts(), { subjectId: subject });
      await t.emit('incident.created', incidentFacts(), { subjectId: subject });
      await t.emit('incident.created', incidentFacts(), { subjectId: randomUUID() });
      const queue = new RecordingQueue();
      expect(await t.dispatch(queue)).toEqual({ events: 3, executions: 2, skipped: 1 });
      const skipped = (await t.executions()).filter((e) => e.status === 'SKIPPED');
      expect(skipped).toHaveLength(1);
      expect(skipped[0]).toMatchObject({ skipReason: 'cooldown', subjectId: subject });
      expect(skipped[0]!.finishedAt).not.toBeNull();
      expect(queue.jobs).toHaveLength(2); // the skipped one is never enqueued
    });

    it('stops a rule that has run too often this hour, and says so', async () => {
      const t = await tenant();
      await t.addRule(notifyRule());
      for (let i = 0; i < 4; i += 1) await t.emit('incident.created', incidentFacts({ number: i }));
      const queue = new RecordingQueue();
      expect(await t.dispatch(queue, 2)).toEqual({ events: 4, executions: 2, skipped: 2 });
      expect((await t.executions()).filter((e) => e.skipReason === 'rate_limited')).toHaveLength(2);
    });

    it('never triggers on an event that an automation caused (the loop guard)', async () => {
      const t = await tenant();
      await t.addRule(notifyRule());
      await t.emit('incident.created', incidentFacts({ source: 'AUTOMATION' }), {
        causedByExecutionId: randomUUID(),
      });
      const queue = new RecordingQueue();
      expect(await t.dispatch(queue)).toEqual({ events: 1, executions: 0, skipped: 0 });
      expect(await t.executions()).toEqual([]);
      const events = await prisma.domainEvent.findMany({ where: { organizationId: t.orgId } });
      expect(events[0]!.dispatchedAt).not.toBeNull(); // handled, not left hanging
    });

    it('survives a rule with a corrupt definition and still handles the good ones', async () => {
      const t = await tenant();
      const bad = await t.addRule(notifyRule({ name: 'Bad' }));
      await prisma.$executeRaw`UPDATE "AutomationRule" SET "conditions" = '[{"nonsense": true}]'::jsonb WHERE id = ${bad.id}::uuid`;
      const good = await t.addRule(notifyRule({ name: 'Good' }));
      await t.emit('incident.created', incidentFacts());
      expect(await t.dispatch(new RecordingQueue())).toMatchObject({ events: 1, executions: 1 });
      expect((await t.executions())[0]!.ruleId).toBe(good.id);
    });

    it('respects the batch size', async () => {
      const t = await tenant();
      await t.addRule(notifyRule());
      for (let i = 0; i < 5; i += 1) await t.emit('incident.created', incidentFacts({ number: i }));
      const queue = new RecordingQueue();
      expect((await t.dispatch(queue, 60, 2)).events).toBe(2);
      expect(await t.executions()).toHaveLength(2);
    });

    it('recovers an execution whose enqueue failed: it stays PENDING and is enqueued later', async () => {
      const t = await tenant();
      await t.addRule(notifyRule());
      await t.emit('incident.created', incidentFacts());
      const down = new RecordingQueue();
      down.failing = true;
      await t.dispatch(down);
      const [execution] = await t.executions();
      expect(execution).toMatchObject({ status: 'PENDING' });
      expect(down.jobs).toEqual([]);

      const up = new RecordingQueue();
      expect(await enqueueStalePending(prisma, up, logger, 0, t.orgId)).toBe(1);
      expect(up.jobs[0]!.data.executionId).toBe(execution!.id);
      // once it has run, the sweep no longer sees it
      await run(t, execution!.id);
      expect(await enqueueStalePending(prisma, up, logger, 0, t.orgId)).toBe(0);
    });
  });

  describe('the notify action', () => {
    async function fired(
      t: Awaited<ReturnType<typeof tenant>>,
      facts = incidentFacts(),
      rule = notifyRule(),
    ) {
      const created = await t.addRule(rule);
      await t.emit('incident.created', facts);
      const queue = new RecordingQueue();
      await t.dispatch(queue);
      const [execution] = await t.executions();
      return { rule: created, execution: execution!, queue };
    }

    it('notifies the members in the chosen roles, and only them', async () => {
      const t = await tenant();
      const { execution } = await fired(t);
      expect(await run(t, execution.id)).toEqual({ status: 'finished', result: 'SUCCEEDED' });

      const found = await t.notifications();
      expect(found.map((n) => n.userId).sort()).toEqual(
        [t.users.OWNER!.id, t.users.ADMIN!.id].sort(),
      );
      // not the developer, the viewer, or the disabled admin
      expect(
        found.some((n) =>
          [t.users.DEVELOPER!.id, t.users.VIEWER!.id, t.disabledId].includes(n.userId),
        ),
      ).toBe(false);
      expect(found[0]).toMatchObject({
        type: 'incident.created',
        title: 'SEV1 incident INC-7: Checkout is down',
        body: 'On Checkout API.',
        inApp: true,
        emailStatus: 'NONE',
        readAt: null,
        executionId: execution.id,
        actionIndex: 0,
      });
      const done = await prisma.automationExecution.findUniqueOrThrow({
        where: { id: execution.id },
      });
      expect(done).toMatchObject({ status: 'SUCCEEDED', attempts: 1 });
      expect(done.startedAt).not.toBeNull();
      expect(done.finishedAt).not.toBeNull();
      expect(done.results).toEqual([
        { index: 0, type: 'notify', status: 'SUCCEEDED', detail: 'notified: 2 in-app' },
      ]);
    });

    it('links each notification to what it is about, with an in-app path only', async () => {
      const t = await tenant();
      const facts = incidentFacts();
      const { execution } = await fired(t, facts);
      await run(t, execution.id);
      for (const n of await t.notifications()) {
        expect(n.link).toBe(`/orgs/${t.orgId}/incidents/${facts.incidentId}`);
      }
    });

    it('is safe to run twice: a finished execution is skipped, and a resumed one cannot duplicate', async () => {
      const t = await tenant();
      const { execution } = await fired(t);
      await run(t, execution.id);
      expect(await run(t, execution.id)).toEqual({
        status: 'skipped',
        reason: 'already SUCCEEDED',
      });
      expect(await t.notifications()).toHaveLength(2);

      // A crash after the notifications were written but before the verdict was stored:
      await prisma.automationExecution.update({
        where: { id: execution.id },
        data: { status: 'RUNNING', results: [], finishedAt: null },
      });
      await run(t, execution.id);
      expect(await t.notifications()).toHaveLength(2); // unique per (execution, action, recipient)
    });

    it('notes the run on the incident timeline, once, as automation', async () => {
      const t = await tenant();
      const incident = await prisma.$transaction((tx) =>
        createIncidentRecord(tx, {
          organizationId: t.orgId,
          title: 'DB down',
          severity: 'SEV1',
          serviceId: t.serviceId,
          source: 'MANUAL',
          actor: { type: 'SYSTEM', id: null },
        }),
      );
      await t.addRule(notifyRule());
      const queue = new RecordingQueue();
      await t.dispatch(queue); // the real incident.created event written by createIncidentRecord
      const [execution] = await t.executions();
      await run(t, execution!.id);
      await run(t, execution!.id); // a repeat adds nothing

      const events = await prisma.incidentEvent.findMany({
        where: { incidentId: incident.id, type: 'AUTOMATION_EXECUTED' },
      });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ actorType: 'AUTOMATION', actorId: null });
      expect(events[0]!.data).toMatchObject({
        executionId: execution!.id,
        status: 'SUCCEEDED',
        actions: ['notify'],
        ruleName: 'Critical incident alert',
      });
      // the notification names the real incident from the real event
      expect((await t.notifications())[0]!.title).toBe(
        `SEV1 incident INC-${incident.number}: DB down`,
      );
    });

    it('resolves assignees from the event and from the incident, at run time', async () => {
      const t = await tenant();
      const assigned = createRuleSchema.parse({
        name: 'Assignment',
        trigger: 'incident.assigned',
        actions: [
          {
            type: 'notify',
            recipients: { assignee: true },
            channels: ['in_app'],
            title: 'Assigned',
          },
        ],
        cooldownSeconds: 0,
      });
      await t.addRule(assigned);
      await t.emit(
        'incident.assigned',
        incidentFacts({ assigneeUserId: t.users.DEVELOPER!.id, assigneeName: 'D' }),
      );
      const queue = new RecordingQueue();
      await t.dispatch(queue);
      const [execution] = await t.executions();
      await run(t, execution!.id);
      expect((await t.notifications()).map((n) => n.userId)).toEqual([t.users.DEVELOPER!.id]);
    });

    it('does not notify a listed person who is no longer a member', async () => {
      const t = await tenant();
      const rule = notifyRule({
        actions: [
          {
            type: 'notify',
            recipients: { userIds: [t.users.VIEWER!.id, t.users.DEVELOPER!.id] },
            channels: ['in_app'],
            title: 'Hi',
          },
        ],
      });
      await prisma.organizationMember.deleteMany({
        where: { organizationId: t.orgId, userId: t.users.VIEWER!.id },
      });
      const { execution } = await fired(t, incidentFacts(), rule);
      await run(t, execution.id);
      expect((await t.notifications()).map((n) => n.userId)).toEqual([t.users.DEVELOPER!.id]);
    });

    it('records "no eligible recipients" instead of failing', async () => {
      const t = await tenant();
      const rule = notifyRule({
        actions: [
          {
            type: 'notify',
            recipients: { userIds: [randomUUID()] },
            channels: ['in_app'],
            title: 'Hi',
          },
        ],
      });
      const { execution } = await fired(t, incidentFacts(), rule);
      expect(await run(t, execution.id)).toEqual({ status: 'finished', result: 'SUCCEEDED' });
      const done = await prisma.automationExecution.findUniqueOrThrow({
        where: { id: execution.id },
      });
      expect(done.results).toEqual([
        {
          index: 0,
          type: 'notify',
          status: 'SKIPPED',
          detail: 'no eligible recipients (are they still members?)',
        },
      ]);
      expect(await t.notifications()).toEqual([]);
    });

    it('stops a queued execution when its rule is disabled, and touches nothing', async () => {
      const t = await tenant();
      const { rule, execution } = await fired(t);
      await prisma.automationRule.update({ where: { id: rule.id }, data: { enabled: false } });
      expect(await run(t, execution.id)).toEqual({ status: 'finished', result: 'SKIPPED' });
      expect(await t.notifications()).toEqual([]);
      expect(
        await prisma.automationExecution.findUniqueOrThrow({ where: { id: execution.id } }),
      ).toMatchObject({
        status: 'SKIPPED',
        skipReason: 'rule_disabled',
      });
    });

    it('cannot be pointed at another organization’s execution', async () => {
      const a = await tenant();
      const b = await tenant();
      const { execution } = await fired(a);
      const outcome = await processExecution(
        { prisma, logger, email: new FakeEmail(), webOrigin: WEB },
        { executionId: execution.id, organizationId: b.orgId },
        { isFinalAttempt: true },
      );
      expect(outcome).toEqual({ status: 'skipped', reason: 'execution no longer exists' });
      expect(await a.notifications()).toEqual([]);
      expect(await b.notifications()).toEqual([]);
    });

    it('reports an action type it cannot run without stopping the others', async () => {
      const t = await tenant();
      const rule = notifyRule({
        actions: [
          { type: 'webhook', destinationId: randomUUID() },
          {
            type: 'notify',
            recipients: { roles: ['OWNER'] },
            channels: ['in_app'],
            title: 'Still runs',
          },
        ],
      });
      const { execution } = await fired(t, incidentFacts(), rule);
      expect(await run(t, execution.id)).toEqual({ status: 'finished', result: 'PARTIAL' });
      expect(await t.notifications()).toHaveLength(1);
    });

    it('substitutes user-controlled text as text only, and bounds it', async () => {
      const t = await tenant();
      const hostile = incidentFacts({
        title: '{{severity}} <script>alert(1)</script>\r\nBcc: evil@example.com ' + 'x'.repeat(500),
      });
      const { execution } = await fired(t, hostile);
      await run(t, execution.id);
      const [n] = await t.notifications();
      expect(n!.title).not.toMatch(/[\r\n]/);
      expect(n!.title.length).toBeLessThanOrEqual(160);
      expect(n!.title).toContain('<script>alert(1)</script>'); // stored as text; the UI escapes it
      expect(n!.title).toContain('{{severity}}'); // not expanded a second time
    });
  });

  describe('email', () => {
    const emailRule = (channels: string[] = ['in_app', 'email']) =>
      notifyRule({
        actions: [
          {
            type: 'notify',
            recipients: { roles: ['OWNER', 'ADMIN'] },
            channels,
            title: 'INC-{{number}}: {{title}}',
            body: 'Details here.',
          },
        ],
      });

    it('sends one plain-text email per recipient, with a link back, and records it', async () => {
      const t = await tenant();
      await t.addRule(emailRule());
      await t.emit('incident.created', incidentFacts({ title: 'Checkout is down' }));
      await t.dispatch(new RecordingQueue());
      const [execution] = await t.executions();
      const email = new FakeEmail();
      await run(t, execution!.id, email);

      expect(email.sent.map((m) => m.to).sort()).toEqual(
        [t.users.OWNER!.email, t.users.ADMIN!.email].sort(),
      );
      expect(email.sent[0]!.subject).toBe('[NEXUS] INC-7: Checkout is down');
      expect(email.sent[0]!.text).toContain('Details here.');
      expect(email.sent[0]!.text).toContain(`${WEB}/orgs/${t.orgId}/incidents/`);
      const found = await t.notifications();
      expect(found.every((n) => n.emailStatus === 'SENT' && n.inApp)).toBe(true);
    });

    it('never puts a line break in a subject, whatever the incident title says', async () => {
      const t = await tenant();
      await t.addRule(emailRule());
      await t.emit(
        'incident.created',
        incidentFacts({ title: 'Down\r\nBcc: attacker@example.com\r\n\r\nInjected body' }),
      );
      await t.dispatch(new RecordingQueue());
      const [execution] = await t.executions();
      const email = new FakeEmail();
      await run(t, execution!.id, email);
      for (const message of email.sent) expect(message.subject).not.toMatch(/[\r\n]/);
      expect(email.sent.every((m) => m.to !== 'attacker@example.com')).toBe(true);
    });

    it('sends nothing for an in-app-only rule, and no in-app row for an email-only rule is shown', async () => {
      const t = await tenant();
      await t.addRule(emailRule(['in_app']));
      await t.emit('incident.created', incidentFacts());
      await t.dispatch(new RecordingQueue());
      const [execution] = await t.executions();
      const email = new FakeEmail();
      await run(t, execution!.id, email);
      expect(email.sent).toEqual([]);

      const t2 = await tenant();
      await t2.addRule(emailRule(['email']));
      await t2.emit('incident.created', incidentFacts());
      await t2.dispatch(new RecordingQueue());
      const [second] = await t2.executions();
      await run(t2, second!.id, email);
      expect(email.sent).toHaveLength(2);
      expect((await t2.notifications()).every((n) => n.inApp === false)).toBe(true);
    });

    it('retries only the emails that failed, and never emails anyone twice', async () => {
      const t = await tenant();
      await t.addRule(emailRule());
      await t.emit('incident.created', incidentFacts());
      await t.dispatch(new RecordingQueue());
      const [execution] = await t.executions();

      const email = new FakeEmail();
      email.failFor.set(t.users.ADMIN!.email, new EmailError('smtp timeout', true));
      // First attempt: not the last, so the job throws for BullMQ to retry it.
      await expect(run(t, execution!.id, email, false)).rejects.toThrow(/retried/);
      expect(email.sent.map((m) => m.to)).toEqual([t.users.OWNER!.email]);
      let rows = await t.notifications();
      expect(rows.find((n) => n.userId === t.users.ADMIN!.id)).toMatchObject({
        emailStatus: 'FAILED',
        emailError: 'smtp timeout',
      });
      expect(rows.find((n) => n.userId === t.users.OWNER!.id)!.emailStatus).toBe('SENT');

      // Second attempt succeeds: only the admin is emailed now.
      email.failFor.clear();
      expect(await run(t, execution!.id, email, true)).toEqual({
        status: 'finished',
        result: 'SUCCEEDED',
      });
      expect(email.sent.map((m) => m.to).sort()).toEqual(
        [t.users.OWNER!.email, t.users.ADMIN!.email].sort(),
      );
      rows = await t.notifications();
      expect(rows).toHaveLength(2);
      expect(rows.every((n) => n.emailStatus === 'SENT')).toBe(true);
      expect(
        (await prisma.automationExecution.findUniqueOrThrow({ where: { id: execution!.id } }))
          .attempts,
      ).toBe(2);
    });

    it('records a final failure instead of retrying forever, and keeps the in-app notification', async () => {
      const t = await tenant();
      await t.addRule(emailRule());
      await t.emit('incident.created', incidentFacts());
      await t.dispatch(new RecordingQueue());
      const [execution] = await t.executions();
      const email = new FakeEmail();
      for (const user of [t.users.OWNER!, t.users.ADMIN!])
        email.failFor.set(user.email, new EmailError('smtp down', true));
      expect(await run(t, execution!.id, email, true)).toEqual({
        status: 'finished',
        result: 'PARTIAL', // in-app was delivered; only the emails failed
      });
      const done = await prisma.automationExecution.findUniqueOrThrow({
        where: { id: execution!.id },
      });
      expect(done.status).toBe('PARTIAL');
      expect(JSON.stringify(done.results)).not.toContain('@'); // no addresses in the record
      expect((await t.notifications()).every((n) => n.inApp && n.emailStatus === 'FAILED')).toBe(
        true,
      );
    });

    it('does not retry a permanent failure such as a rejected address', async () => {
      const t = await tenant();
      await t.addRule(emailRule());
      await t.emit('incident.created', incidentFacts());
      await t.dispatch(new RecordingQueue());
      const [execution] = await t.executions();
      const email = new FakeEmail();
      email.failFor.set(t.users.ADMIN!.email, new EmailError('mailbox does not exist', false));
      // Not the final attempt, yet nothing is thrown: retrying cannot help.
      expect(await run(t, execution!.id, email, false)).toEqual({
        status: 'finished',
        result: 'PARTIAL',
      });
    });
  });

  describe('retention', () => {
    it('deletes old dispatched events and their executions, never work still to do, and old notifications', async () => {
      const t = await tenant();
      await t.addRule(notifyRule());
      const oldDone = await t.emit('incident.created', incidentFacts());
      await t.emit('incident.created', incidentFacts());
      await t.dispatch(new RecordingQueue());
      const stillToDo = await t.emit('incident.created', incidentFacts());
      const [execution] = await t.executions();
      await run(t, execution!.id);

      await prisma.$executeRaw`UPDATE "DomainEvent" SET "dispatchedAt" = now() - interval '100 days', "occurredAt" = now() - interval '100 days' WHERE id = ${oldDone}::uuid`;
      await prisma.$executeRaw`UPDATE "DomainEvent" SET "occurredAt" = now() - interval '100 days' WHERE id = ${stillToDo}::uuid`;
      await prisma.$executeRaw`UPDATE "Notification" SET "createdAt" = now() - interval '100 days' WHERE "organizationId" = ${t.orgId}::uuid`;

      expect(await cleanupOldAutomationData(prisma, 90)).toBeGreaterThanOrEqual(1);
      expect(await prisma.domainEvent.findUnique({ where: { id: oldDone } })).toBeNull();
      expect(await prisma.domainEvent.findUnique({ where: { id: stillToDo } })).not.toBeNull(); // undispatched
      expect((await t.executions()).every((e) => e.eventId !== oldDone)).toBe(true);
      expect(await cleanupOldNotifications(prisma, 90)).toBeGreaterThanOrEqual(1);
      expect(await t.notifications()).toEqual([]);
    });
  });
});
