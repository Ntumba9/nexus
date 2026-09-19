import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { emitDomainEvent, type PrismaClient } from '@nexus/database';
import { createRuleSchema, type AutomationTrigger, type CreateRuleInput } from '@nexus/shared';
import { encryptSecret, generateWebhookSecret } from '@nexus/shared/webhook-security';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLogger } from '../logger';
import { HAS_DB, seedService, testPrisma } from '../testing/db';
import { createActionHandlers } from './actions/handlers';
import { createWebhookHandler } from './actions/webhook';
import { dispatchDomainEvents, type AutomationQueue } from './dispatcher';
import type { EmailMessage, EmailSender } from './email';
import { processExecution } from './executor';
import { createSafePoster } from './safe-post';

const logger = createLogger('silent');
const KEY = randomBytes(32);

class NullQueue implements AutomationQueue {
  async add(): Promise<void> {}
}
class FakeEmail implements EmailSender {
  sent: EmailMessage[] = [];
  async send(message: EmailMessage): Promise<void> {
    this.sent.push(message);
  }
}

interface Received {
  headers: http.IncomingHttpHeaders;
  body: string;
  url: string;
}

/** A tiny receiver whose answer the test controls. */
async function receiver(
  respond: (
    call: number,
    request: Received,
  ) => { status: number; headers?: Record<string, string> } | 'hang',
) {
  const received: Received[] = [];
  const sockets = new Set<import('node:net').Socket>();
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const call = {
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
        url: req.url ?? '',
      };
      received.push(call);
      const answer = respond(received.length, call);
      if (answer === 'hang') return; // never answers
      res.writeHead(answer.status, answer.headers);
      res.end('ignored');
    });
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/hook`,
    received,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

const rule = (over: Record<string, unknown> = {}): CreateRuleInput =>
  createRuleSchema.parse({
    name: 'Deployment failed',
    trigger: 'deployment.failed',
    actions: [{ type: 'webhook', destinationId: randomUUID() }],
    cooldownSeconds: 0,
    ...over,
  });

const deploymentFacts = (over: Record<string, unknown> = {}) => ({
  deploymentId: randomUUID(),
  serviceId: null,
  serviceName: 'Checkout API',
  repoFullName: 'acme/storefront',
  environment: 'production',
  ref: 'main',
  commitSha: 'abcdef1234567890abcdef1234567890abcdef12',
  commitShort: 'abcdef1',
  author: 'octocat',
  status: 'FAILURE',
  ...over,
});

describe.skipIf(!HAS_DB)('webhook and create_incident actions (integration)', () => {
  let prisma: PrismaClient;
  beforeAll(() => {
    prisma = testPrisma();
  });
  afterAll(() => prisma.$disconnect());

  async function tenant() {
    const base = await seedService(prisma, 'Checkout API');
    const orgId = base.organizationId;
    const destination = async (
      url: string,
      over: { enabled?: boolean; secret?: string; key?: Buffer; org?: string } = {},
    ) => {
      const id = randomUUID();
      const secret = over.secret ?? generateWebhookSecret();
      await prisma.outboundWebhook.create({
        data: {
          id,
          organizationId: over.org ?? orgId,
          name: 'Pager',
          url,
          secretEncrypted: encryptSecret(secret, over.key ?? KEY, id),
          enabled: over.enabled ?? true,
        },
      });
      return { id, secret };
    };
    const fire = async (
      ruleInput: CreateRuleInput,
      trigger: AutomationTrigger,
      facts: Record<string, unknown>,
    ) => {
      await prisma.automationRule.create({
        data: {
          organizationId: orgId,
          name: ruleInput.name,
          trigger: ruleInput.trigger,
          conditions: ruleInput.conditions as never,
          actions: ruleInput.actions as never,
          cooldownSeconds: ruleInput.cooldownSeconds,
        },
      });
      await prisma.$transaction((tx) =>
        emitDomainEvent(tx, {
          organizationId: orgId,
          type: trigger,
          subjectId: randomUUID(),
          facts,
        }),
      );
      await dispatchDomainEvents(prisma, new NullQueue(), logger, {
        maxExecutionsPerRulePerHour: 100,
        organizationId: orgId,
      });
      const execution = await prisma.automationExecution.findFirstOrThrow({
        where: { organizationId: orgId },
        orderBy: { createdAt: 'desc' },
      });
      return execution;
    };
    const run = (
      executionId: string,
      opts: {
        key?: Buffer | undefined;
        allowPrivate?: boolean;
        isFinalAttempt?: boolean;
        email?: EmailSender;
        timeoutMs?: number;
      } = {},
    ) => {
      const key = 'key' in opts ? opts.key : KEY;
      const post = createSafePoster({ allowPrivate: opts.allowPrivate ?? true });
      const handlers = createActionHandlers({ key, post });
      if (opts.timeoutMs) {
        handlers.webhook = createWebhookHandler({ key, post, timeoutMs: opts.timeoutMs }) as never;
      }
      return processExecution(
        {
          prisma,
          logger,
          email: opts.email ?? new FakeEmail(),
          webOrigin: 'https://nexus.example.com',
          handlers,
        },
        { executionId, organizationId: orgId },
        { isFinalAttempt: opts.isFinalAttempt ?? true },
      );
    };
    const results = async (executionId: string) =>
      await prisma.automationExecution.findUniqueOrThrow({ where: { id: executionId } });
    return { ...base, orgId, destination, fire, run, results };
  }

  describe('webhook', () => {
    it('delivers one signed JSON request that the receiver can verify, without leaking the secret', async () => {
      const t = await tenant();
      const server = await receiver(() => ({ status: 200 }));
      try {
        const dest = await t.destination(server.url);
        const facts = deploymentFacts();
        const execution = await t.fire(
          rule({ actions: [{ type: 'webhook', destinationId: dest.id }] }),
          'deployment.failed',
          facts,
        );
        expect(await t.run(execution.id)).toEqual({ status: 'finished', result: 'SUCCEEDED' });

        expect(server.received).toHaveLength(1);
        const [call] = server.received;
        expect(call!.headers['content-type']).toBe('application/json');
        expect(call!.headers['x-nexus-event']).toBe('deployment.failed');
        expect(call!.headers['x-nexus-delivery']).toBe(`${execution.id}:0`);

        // The receiver's check: HMAC over `${timestamp}.${body}` with the shared secret.
        const timestamp = call!.headers['x-nexus-timestamp'] as string;
        expect(Math.abs(Date.now() / 1000 - Number(timestamp))).toBeLessThan(30);
        const expected =
          'sha256=' +
          createHmac('sha256', dest.secret).update(`${timestamp}.${call!.body}`).digest('hex');
        expect(call!.headers['x-nexus-signature-256']).toBe(expected);

        const payload = JSON.parse(call!.body);
        expect(payload).toMatchObject({
          id: `${execution.id}:0`,
          type: 'deployment.failed',
          organizationId: t.orgId,
          rule: { name: 'Deployment failed' },
          data: {
            repoFullName: 'acme/storefront',
            commitShort: 'abcdef1',
            environment: 'production',
          },
          link: `/orgs/${t.orgId}/deployments`,
        });
        // The secret is never in the body, headers or stored result.
        expect(call!.body).not.toContain(dest.secret);
        expect(JSON.stringify(call!.headers)).not.toContain(dest.secret);
        const stored = await t.results(execution.id);
        expect(JSON.stringify(stored.results)).not.toContain(dest.secret);
        expect(JSON.stringify(stored.results)).not.toContain('127.0.0.1');
        expect(stored.results).toEqual([
          { index: 0, type: 'webhook', status: 'SUCCEEDED', detail: 'delivered (HTTP 200)' },
        ]);
      } finally {
        await server.close();
      }
    });

    it('a wrong secret would not verify (the signature really depends on it)', async () => {
      const t = await tenant();
      const server = await receiver(() => ({ status: 200 }));
      try {
        const dest = await t.destination(server.url);
        const execution = await t.fire(
          rule({ actions: [{ type: 'webhook', destinationId: dest.id }] }),
          'deployment.failed',
          deploymentFacts(),
        );
        await t.run(execution.id);
        const [call] = server.received;
        const wrong = createHmac('sha256', 'not-the-secret')
          .update(`${call!.headers['x-nexus-timestamp']}.${call!.body}`)
          .digest('hex');
        expect(call!.headers['x-nexus-signature-256']).not.toBe(`sha256=${wrong}`);
      } finally {
        await server.close();
      }
    });

    it('retries a transient failure with the same delivery id, and a permanent one not at all', async () => {
      const t = await tenant();
      const flaky = await receiver((call) => ({ status: call === 1 ? 503 : 200 }));
      try {
        const dest = await t.destination(flaky.url);
        const execution = await t.fire(
          rule({ actions: [{ type: 'webhook', destinationId: dest.id }] }),
          'deployment.failed',
          deploymentFacts(),
        );
        await expect(t.run(execution.id, { isFinalAttempt: false })).rejects.toThrow(/retried/);
        expect(await t.run(execution.id, { isFinalAttempt: true })).toEqual({
          status: 'finished',
          result: 'SUCCEEDED',
        });
        expect(flaky.received).toHaveLength(2);
        expect(flaky.received[0]!.headers['x-nexus-delivery']).toBe(
          flaky.received[1]!.headers['x-nexus-delivery'],
        );
      } finally {
        await flaky.close();
      }

      const t2 = await tenant();
      const gone = await receiver(() => ({ status: 404 }));
      try {
        const dest = await t2.destination(gone.url);
        const execution = await t2.fire(
          rule({ actions: [{ type: 'webhook', destinationId: dest.id }] }),
          'deployment.failed',
          deploymentFacts(),
        );
        // not the final attempt, yet nothing is thrown: retrying a 404 cannot help
        expect(await t2.run(execution.id, { isFinalAttempt: false })).toEqual({
          status: 'finished',
          result: 'FAILED',
        });
        expect(gone.received).toHaveLength(1);
        expect((await t2.results(execution.id)).results).toEqual([
          { index: 0, type: 'webhook', status: 'FAILED', detail: 'the receiver answered HTTP 404' },
        ]);
      } finally {
        await gone.close();
      }
    });

    it.each([429, 500, 502, 503])('treats HTTP %s as worth retrying', async (status) => {
      const t = await tenant();
      const server = await receiver(() => ({ status }));
      try {
        const dest = await t.destination(server.url);
        const execution = await t.fire(
          rule({ actions: [{ type: 'webhook', destinationId: dest.id }] }),
          'deployment.failed',
          deploymentFacts(),
        );
        await expect(t.run(execution.id, { isFinalAttempt: false })).rejects.toThrow(/retried/);
      } finally {
        await server.close();
      }
    });

    it('never follows a redirect (a public URL cannot bounce us elsewhere)', async () => {
      const t = await tenant();
      const target = await receiver(() => ({ status: 200 }));
      const redirector = await receiver(() => ({ status: 302, headers: { location: target.url } }));
      try {
        const dest = await t.destination(redirector.url);
        const execution = await t.fire(
          rule({ actions: [{ type: 'webhook', destinationId: dest.id }] }),
          'deployment.failed',
          deploymentFacts(),
        );
        expect(await t.run(execution.id, { isFinalAttempt: false })).toEqual({
          status: 'finished',
          result: 'FAILED',
        });
        expect(redirector.received).toHaveLength(1);
        expect(target.received).toHaveLength(0);
      } finally {
        await redirector.close();
        await target.close();
      }
    });

    it('refuses private and internal addresses unless the operator opted in', async () => {
      const t = await tenant();
      const server = await receiver(() => ({ status: 200 }));
      try {
        const dest = await t.destination(server.url); // 127.0.0.1
        const execution = await t.fire(
          rule({ actions: [{ type: 'webhook', destinationId: dest.id }] }),
          'deployment.failed',
          deploymentFacts(),
        );
        expect(await t.run(execution.id, { allowPrivate: false, isFinalAttempt: false })).toEqual({
          status: 'finished',
          result: 'FAILED',
        });
        expect(server.received).toHaveLength(0); // nothing was ever sent
        expect(JSON.stringify((await t.results(execution.id)).results)).toContain(
          'address not allowed',
        );
      } finally {
        await server.close();
      }
    });

    it('treats a receiver that never answers as a retryable timeout', async () => {
      const t = await tenant();
      const server = await receiver(() => 'hang');
      try {
        const dest = await t.destination(server.url);
        const execution = await t.fire(
          rule({ actions: [{ type: 'webhook', destinationId: dest.id }] }),
          'deployment.failed',
          deploymentFacts(),
        );
        await expect(
          t.run(execution.id, { isFinalAttempt: false, timeoutMs: 300 }),
        ).rejects.toThrow(/retried/);
        expect(JSON.stringify((await t.results(execution.id)).results)).toContain('timed out');
      } finally {
        await server.close();
      }
    });

    it('cannot use a disabled destination, another organization’s destination, or a missing one', async () => {
      const t = await tenant();
      const other = await tenant();
      const server = await receiver(() => ({ status: 200 }));
      try {
        const disabled = await t.destination(server.url, { enabled: false });
        const theirs = await other.destination(server.url);
        for (const destinationId of [disabled.id, theirs.id, randomUUID()]) {
          const t2 = await tenant();
          const execution = await t2.fire(
            rule({ actions: [{ type: 'webhook', destinationId }] }),
            'deployment.failed',
            deploymentFacts(),
          );
          expect(await t2.run(execution.id)).toEqual({ status: 'finished', result: 'FAILED' });
          expect(JSON.stringify((await t2.results(execution.id)).results)).toContain(
            'no longer exists or is disabled',
          );
        }
        expect(server.received).toHaveLength(0);
      } finally {
        await server.close();
      }
    });

    it('fails clearly when webhooks are not configured, or the secret cannot be read', async () => {
      const t = await tenant();
      const server = await receiver(() => ({ status: 200 }));
      try {
        const dest = await t.destination(server.url);
        const a = await t.fire(
          rule({ actions: [{ type: 'webhook', destinationId: dest.id }] }),
          'deployment.failed',
          deploymentFacts(),
        );
        await t.run(a.id, { key: undefined });
        expect(JSON.stringify((await t.results(a.id)).results)).toContain(
          'not enabled on this server',
        );

        const t2 = await tenant();
        const wrongKeyDest = await t2.destination(server.url, { key: randomBytes(32) });
        const b = await t2.fire(
          rule({ actions: [{ type: 'webhook', destinationId: wrongKeyDest.id }] }),
          'deployment.failed',
          deploymentFacts(),
        );
        await t2.run(b.id);
        expect(JSON.stringify((await t2.results(b.id)).results)).toContain('could not be read');
        expect(server.received).toHaveLength(0);
      } finally {
        await server.close();
      }
    });
  });

  describe('create_incident', () => {
    const incidentRule = (over: Record<string, unknown> = {}) =>
      rule({
        name: 'Open on failed deploy',
        actions: [
          {
            type: 'create_incident',
            title: 'Deployment failed: {{repoFullName}}@{{commitShort}}',
            description: '{{author}} deployed {{ref}} to {{environment}}.',
            severity: 'SEV3',
            attachEventService: true,
          },
        ],
        ...over,
      });

    it('opens an incident as the automation, attached to the event’s service, with an audit entry', async () => {
      const t = await tenant();
      const execution = await t.fire(
        incidentRule(),
        'deployment.failed',
        deploymentFacts({ serviceId: t.serviceId }),
      );
      expect(await t.run(execution.id)).toEqual({ status: 'finished', result: 'SUCCEEDED' });

      const incident = await prisma.incident.findFirstOrThrow({
        where: { organizationId: t.orgId },
      });
      expect(incident).toMatchObject({
        title: 'Deployment failed: acme/storefront@abcdef1',
        description: 'octocat deployed main to production.',
        severity: 'SEV3',
        source: 'AUTOMATION',
        createdById: null,
        serviceId: t.serviceId,
        status: 'OPEN',
      });
      const created = await prisma.incidentEvent.findFirstOrThrow({
        where: { incidentId: incident.id, type: 'CREATED' },
      });
      expect(created).toMatchObject({ actorType: 'AUTOMATION', actorId: null });
      expect(created.data).toMatchObject({
        executionId: execution.id,
        actionIndex: 0,
        rule: 'Open on failed deploy',
      });

      const audit = await prisma.auditLog.findMany({ where: { organizationId: t.orgId } });
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        action: 'automation.incident.created',
        actorType: 'AUTOMATION',
        actorId: null,
        actorLabel: 'NEXUS automation',
        resourceType: 'incident',
        resourceId: incident.id,
      });
      expect(audit[0]!.metadata).toMatchObject({
        rule: 'Open on failed deploy',
        executionId: execution.id,
        incidentNumber: incident.number,
      });
      expect((await t.results(execution.id)).results).toEqual([
        {
          index: 0,
          type: 'create_incident',
          status: 'SUCCEEDED',
          detail: `opened incident INC-${incident.number}`,
        },
      ]);
    });

    it('never starts a chain: the incident it opens cannot trigger another rule', async () => {
      const t = await tenant();
      // A second rule that WOULD match the incident this one opens.
      await prisma.automationRule.create({
        data: {
          organizationId: t.orgId,
          name: 'Alert on any new incident',
          trigger: 'incident.created',
          conditions: [],
          actions: [
            {
              type: 'notify',
              recipients: { roles: ['ADMIN'] },
              channels: ['in_app'],
              title: 'x',
              body: '',
            },
          ],
          cooldownSeconds: 0,
        },
      });
      const execution = await t.fire(incidentRule(), 'deployment.failed', deploymentFacts());
      await t.run(execution.id);

      const events = await prisma.domainEvent.findMany({
        where: { organizationId: t.orgId, type: 'incident.created' },
      });
      expect(events).toHaveLength(1);
      expect(events[0]!.causedByExecutionId).toBe(execution.id);
      const queue = new NullQueue();
      const dispatched = await dispatchDomainEvents(prisma, queue, logger, {
        maxExecutionsPerRulePerHour: 100,
        organizationId: t.orgId,
      });
      expect(dispatched.executions).toBe(0);
      expect(await prisma.automationExecution.count({ where: { organizationId: t.orgId } })).toBe(
        1,
      ); // only the original
    });

    it('is idempotent: running it again (a retry after a crash) does not open a second incident', async () => {
      const t = await tenant();
      const execution = await t.fire(incidentRule(), 'deployment.failed', deploymentFacts());
      await t.run(execution.id);
      await prisma.automationExecution.update({
        where: { id: execution.id },
        data: { status: 'RUNNING', results: [], finishedAt: null },
      });
      await t.run(execution.id);
      expect(await prisma.incident.count({ where: { organizationId: t.orgId } })).toBe(1);
      expect(await prisma.auditLog.count({ where: { organizationId: t.orgId } })).toBe(1);
      expect(JSON.stringify((await t.results(execution.id)).results)).toContain(
        'was already opened',
      );
    });

    it('opens exactly one incident even when two workers run the same action at once', async () => {
      const t = await tenant();
      const execution = await t.fire(incidentRule(), 'deployment.failed', deploymentFacts());
      await Promise.allSettled([t.run(execution.id), t.run(execution.id), t.run(execution.id)]);
      expect(await prisma.incident.count({ where: { organizationId: t.orgId } })).toBe(1);
    });

    it('does not attach a service that belongs to another organization, or one that is archived', async () => {
      const t = await tenant();
      const foreign = await seedService(prisma, 'Foreign API');
      const first = await t.fire(
        incidentRule({ name: 'foreign' }),
        'deployment.failed',
        deploymentFacts({ serviceId: foreign.serviceId }),
      );
      await t.run(first.id);
      await prisma.service.update({ where: { id: t.serviceId }, data: { archivedAt: new Date() } });
      const second = await t.fire(
        incidentRule({ name: 'archived' }),
        'deployment.failed',
        deploymentFacts({ serviceId: t.serviceId }),
      );
      await t.run(second.id);
      const incidents = await prisma.incident.findMany({ where: { organizationId: t.orgId } });
      expect(incidents).toHaveLength(2);
      expect(incidents.every((i) => i.serviceId === null)).toBe(true);
    });

    it('can be told not to attach the event’s service', async () => {
      const t = await tenant();
      const detached = incidentRule({
        actions: [
          { type: 'create_incident', title: 'X', severity: 'SEV4', attachEventService: false },
        ],
      });
      const execution = await t.fire(
        detached,
        'deployment.failed',
        deploymentFacts({ serviceId: t.serviceId }),
      );
      await t.run(execution.id);
      expect(
        (await prisma.incident.findFirstOrThrow({ where: { organizationId: t.orgId } })).serviceId,
      ).toBeNull();
    });

    it('substitutes hostile text as plain text', async () => {
      const t = await tenant();
      const execution = await t.fire(
        incidentRule(),
        'deployment.failed',
        deploymentFacts({
          author: '<img src=x onerror=alert(1)>\r\nInjected: header',
          ref: '{{author}}',
        }),
      );
      await t.run(execution.id);
      const incident = await prisma.incident.findFirstOrThrow({
        where: { organizationId: t.orgId },
      });
      expect(incident.title).not.toMatch(/[\r\n]/);
      expect(incident.description).toContain('<img src=x onerror=alert(1)>'); // stored as text; the UI escapes it
      expect(incident.description).toContain('{{author}}'); // not expanded a second time
    });
  });

  it('runs every action of a rule: a failed deployment opens an incident, calls a webhook and notifies', async () => {
    const t = await tenant();
    const server = await receiver(() => ({ status: 200 }));
    try {
      const admin = await prisma.user.create({
        data: {
          email: `a-${randomUUID().slice(0, 8)}@example.com`,
          name: 'Admin',
          passwordHash: '$argon2id$test-only-not-a-real-hash',
        },
      });
      await prisma.organizationMember.create({
        data: { organizationId: t.orgId, userId: admin.id, role: 'ADMIN' },
      });
      const dest = await t.destination(server.url);
      const execution = await t.fire(
        rule({
          actions: [
            {
              type: 'create_incident',
              title: 'Deploy failed',
              severity: 'SEV3',
              attachEventService: false,
            },
            { type: 'webhook', destinationId: dest.id },
            {
              type: 'notify',
              recipients: { roles: ['ADMIN'] },
              channels: ['in_app'],
              title: 'Deploy failed',
              body: '',
            },
          ],
        }),
        'deployment.failed',
        deploymentFacts(),
      );
      expect(await t.run(execution.id)).toEqual({ status: 'finished', result: 'SUCCEEDED' });
      expect(
        await prisma.incident.count({ where: { organizationId: t.orgId, source: 'AUTOMATION' } }),
      ).toBe(1);
      expect(server.received).toHaveLength(1);
      expect(
        await prisma.notification.count({ where: { organizationId: t.orgId, userId: admin.id } }),
      ).toBe(1);
      const done = await t.results(execution.id);
      expect((done.results as { status: string }[]).map((r) => r.status)).toEqual([
        'SUCCEEDED',
        'SUCCEEDED',
        'SUCCEEDED',
      ]);
    } finally {
      await server.close();
    }
  });
});
