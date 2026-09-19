import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import type { CreatedGitHubIntegrationDto, IncidentDeploymentsDto, Role } from '@nexus/shared';
import { computeGitHubSignature, decryptSecret } from '@nexus/shared/webhook-security';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createIncident, createProject, createService } from '../testing/fixtures';
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
const CAN_MANAGE_INTEGRATIONS: Role[] = ['OWNER', 'ADMIN'];
const CAN_LINK: Role[] = ['OWNER', 'ADMIN', 'DEVELOPER', 'SUPPORT'];

const randomIp = () => `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`;
const repoName = () => `acme/repo-${randomUUID().slice(0, 8)}`;

const deploymentEvent = (repo: string, over: Record<string, unknown> = {}) => ({
  action: 'created',
  deployment_status: { state: 'success', created_at: new Date().toISOString() },
  deployment: {
    id: randomInt(1, 1_000_000),
    sha: 'a'.repeat(40),
    ref: 'main',
    environment: 'production',
    created_at: new Date().toISOString(),
    creator: { login: 'octocat' },
  },
  repository: { full_name: repo },
  ...over,
});

describe.skipIf(!HAS_INFRA)('GitHub integration (integration)', () => {
  let t: TestApp;
  let owner: TestUser;
  let orgId: string;
  let projectId: string;
  let serviceId: string;
  const actors = {} as Record<Role, TestUser & { memberId: string }>;

  beforeAll(async () => {
    t = await createTestApp({ env: { INTEGRATION_ENCRYPTION_KEY: KEY } });
    owner = await registerUser(t, 'GitHub Owner');
    orgId = (await createOrg(owner, 'GitHub Org')).id;
    projectId = (await createProject(owner, orgId)).id;
    serviceId = (await createService(owner, orgId, projectId, 'Checkout')).id;
    for (const role of ROLES) actors[role] = await userWithRole(t, orgId, role);
  });
  afterAll(() => t.close());

  const connect = async (
    user: TestUser = owner,
    org = orgId,
    body: Record<string, unknown> = {},
  ): Promise<CreatedGitHubIntegrationDto> => {
    const res = await user.client.post(`/orgs/${org}/integrations/github`, {
      repoFullName: repoName(),
      projectId,
      serviceId,
      ...body,
    });
    if (res.status !== 201)
      throw new Error(`connect failed: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body as CreatedGitHubIntegrationDto;
  };

  /** Deliver a webhook exactly as GitHub does: raw JSON body, signature header, no Origin/cookie. */
  const deliver = (
    integration: { id: string },
    secret: string,
    body: unknown,
    opts: {
      event?: string;
      delivery?: string | null;
      signature?: string | null;
      contentType?: string;
      ip?: string;
      raw?: string;
    } = {},
  ) => {
    const raw = opts.raw ?? JSON.stringify(body);
    const req = request(t.server)
      .post(`/api/v1/webhooks/github/${integration.id}`)
      .set('X-Forwarded-For', opts.ip ?? randomIp())
      .set('Content-Type', opts.contentType ?? 'application/json')
      .set('X-GitHub-Event', opts.event ?? 'deployment_status');
    if (opts.delivery !== null) req.set('X-GitHub-Delivery', opts.delivery ?? randomUUID());
    if (opts.signature !== null) {
      req.set(
        'X-Hub-Signature-256',
        opts.signature ?? computeGitHubSignature(secret, Buffer.from(raw)),
      );
    }
    return req.send(raw);
  };

  describe('managing integrations', () => {
    it('returns the secret exactly once and stores it encrypted', async () => {
      const created = await connect();
      expect(created.webhookSecret).toMatch(/^[0-9a-f]{64}$/);
      expect(created.webhookPath).toBe(`/api/v1/webhooks/github/${created.id}`);
      expect(created.status).toBe('ACTIVE');

      const list = await owner.client.get(`/orgs/${orgId}/integrations/github`);
      expect(list.status).toBe(200);
      const listed = (list.body.data as Array<Record<string, unknown>>).find(
        (i) => i.id === created.id,
      );
      expect(listed).toBeDefined();
      expect(JSON.stringify(list.body)).not.toContain(created.webhookSecret);
      expect(listed).not.toHaveProperty('webhookSecret');
      expect(listed).not.toHaveProperty('webhookSecretEncrypted');

      const row = await t.prisma.gitHubIntegration.findUniqueOrThrow({ where: { id: created.id } });
      expect(row.webhookSecretEncrypted).not.toContain(created.webhookSecret);
      expect(
        decryptSecret(row.webhookSecretEncrypted, Buffer.from(KEY, 'base64'), created.id),
      ).toBe(created.webhookSecret);
    });

    it.each(ROLES)('%s: create permission matches the role', async (role) => {
      const res = await actors[role].client.post(`/orgs/${orgId}/integrations/github`, {
        repoFullName: repoName(),
        projectId,
      });
      expect(res.status).toBe(CAN_MANAGE_INTEGRATIONS.includes(role) ? 201 : 403);
      const list = await actors[role].client.get(`/orgs/${orgId}/integrations/github`);
      expect(list.status).toBe(200); // everyone can see which repositories are connected
    });

    it('allows one active integration per repository, and frees it when disabled', async () => {
      const repo = repoName();
      const first = await connect(owner, orgId, { repoFullName: repo });
      const dup = await owner.client.post(`/orgs/${orgId}/integrations/github`, {
        repoFullName: repo.toUpperCase(),
        projectId,
      });
      expect(dup.status).toBe(409);
      expect(dup.body.error.code).toBe('INTEGRATION_EXISTS');

      expect(
        (await owner.client.delete(`/orgs/${orgId}/integrations/github/${first.id}`)).status,
      ).toBe(204);
      expect(
        (await owner.client.delete(`/orgs/${orgId}/integrations/github/${first.id}`)).status,
      ).toBe(404);
      await connect(owner, orgId, { repoFullName: repo }); // no longer a conflict
    });

    it('validates input', async () => {
      for (const body of [
        { repoFullName: 'not-a-repo', projectId },
        { repoFullName: repoName() },
        { repoFullName: repoName(), projectId: 'nope' },
      ]) {
        expect((await owner.client.post(`/orgs/${orgId}/integrations/github`, body)).status).toBe(
          400,
        );
      }
    });

    it("cannot use another organization's project or a service from another project", async () => {
      const other = await registerUser(t, 'Other Owner');
      const otherOrg = (await createOrg(other, 'Other Org')).id;
      const otherProject = (await createProject(other, otherOrg)).id;
      const otherService = (await createService(other, otherOrg, otherProject)).id;

      const crossProject = await owner.client.post(`/orgs/${orgId}/integrations/github`, {
        repoFullName: repoName(),
        projectId: otherProject,
      });
      expect(crossProject.status).toBe(404);
      const crossService = await owner.client.post(`/orgs/${orgId}/integrations/github`, {
        repoFullName: repoName(),
        projectId,
        serviceId: otherService,
      });
      expect(crossService.status).toBe(404);

      // ...and cannot see or disable another organization's integrations through its own path.
      const theirs = await connect(other, otherOrg, {
        projectId: otherProject,
        serviceId: otherService,
      });
      const seen = await owner.client.get(`/orgs/${orgId}/integrations/github`);
      expect((seen.body.data as Array<{ id: string }>).some((i) => i.id === theirs.id)).toBe(false);
      expect(
        (await owner.client.delete(`/orgs/${orgId}/integrations/github/${theirs.id}`)).status,
      ).toBe(404);
      expect(
        (await t.prisma.gitHubIntegration.findUniqueOrThrow({ where: { id: theirs.id } })).status,
      ).toBe('ACTIVE');
    });

    it('requires authentication and refuses non-members', async () => {
      const anon = await owner.client.get(`/orgs/${orgId}/integrations/github`, { cookie: null });
      expect(anon.status).toBe(401);
      const stranger = await registerUser(t, 'Stranger');
      expect((await stranger.client.get(`/orgs/${orgId}/integrations/github`)).status).toBe(404);
    });
  });

  describe('receiving webhooks', () => {
    it('accepts a correctly signed delivery, stores it and queues it, without a session or Origin', async () => {
      const it = await connect();
      const body = deploymentEvent(it.repoFullName);
      const delivery = randomUUID();
      const res = await deliver(it, it.webhookSecret, body, { delivery });
      expect(res.status).toBe(202);
      expect(res.body).toEqual({ status: 'accepted' });

      const stored = await t.prisma.webhookEvent.findUniqueOrThrow({
        where: { integrationId_deliveryId: { integrationId: it.id, deliveryId: delivery } },
      });
      expect(stored).toMatchObject({ eventType: 'deployment_status', organizationId: orgId });
      expect(stored.payload).toMatchObject({ repository: { full_name: it.repoFullName } });
      const refreshed = await t.prisma.gitHubIntegration.findUniqueOrThrow({
        where: { id: it.id },
      });
      expect(refreshed.lastEventAt).not.toBeNull();
    });

    it('rejects a wrong secret, a tampered body and a missing or malformed signature', async () => {
      const it = await connect();
      const other = await connect();
      const body = deploymentEvent(it.repoFullName);
      const raw = JSON.stringify(body);

      const wrongSecret = await deliver(it, other.webhookSecret, body);
      expect(wrongSecret.status).toBe(401);
      expect(wrongSecret.body.error.code).toBe('INVALID_SIGNATURE');

      const tampered = await deliver(it, it.webhookSecret, body, {
        signature: computeGitHubSignature(it.webhookSecret, Buffer.from(raw)),
        raw: raw.replace('main', 'evil'),
      });
      expect(tampered.status).toBe(401);

      for (const signature of [null, '', 'sha256=', 'sha1=abcdef', 'sha256=' + 'zz'.repeat(32)]) {
        const res = await deliver(it, it.webhookSecret, body, { signature });
        expect(res.status).toBe(401);
      }
      expect(await t.prisma.webhookEvent.count({ where: { integrationId: it.id } })).toBe(0);
    });

    it("does not accept one integration's secret for another integration", async () => {
      const a = await connect();
      const b = await connect();
      const res = await deliver(b, a.webhookSecret, deploymentEvent(b.repoFullName));
      expect(res.status).toBe(401);
    });

    it('treats a redelivery as a duplicate and stores it once', async () => {
      const it = await connect();
      const delivery = randomUUID();
      const body = deploymentEvent(it.repoFullName);
      expect((await deliver(it, it.webhookSecret, body, { delivery })).body.status).toBe(
        'accepted',
      );
      const again = await deliver(it, it.webhookSecret, body, { delivery });
      expect(again.status).toBe(202);
      expect(again.body.status).toBe('duplicate');
      expect(await t.prisma.webhookEvent.count({ where: { integrationId: it.id } })).toBe(1);
    });

    it('scopes delivery ids per integration, so one tenant cannot suppress another', async () => {
      const a = await connect();
      const b = await connect();
      const delivery = randomUUID();
      expect(
        (await deliver(a, a.webhookSecret, deploymentEvent(a.repoFullName), { delivery })).body
          .status,
      ).toBe('accepted');
      expect(
        (await deliver(b, b.webhookSecret, deploymentEvent(b.repoFullName), { delivery })).body
          .status,
      ).toBe('accepted');
    });

    it('acknowledges events it does not handle without storing them', async () => {
      const it = await connect();
      const res = await deliver(
        it,
        it.webhookSecret,
        { ref: 'refs/heads/main' },
        { event: 'push' },
      );
      expect(res.status).toBe(202);
      expect(res.body.status).toBe('ignored');
      expect(await t.prisma.webhookEvent.count({ where: { integrationId: it.id } })).toBe(0);
    });

    it('accepts GitHub ping', async () => {
      const it = await connect();
      const res = await deliver(
        it,
        it.webhookSecret,
        { zen: 'Keep it logically awesome.' },
        { event: 'ping' },
      );
      expect(res.status).toBe(202);
      expect(res.body.status).toBe('accepted');
    });

    it('rejects a signed delivery that is not JSON or lacks valid GitHub headers', async () => {
      const it = await connect();
      const body = deploymentEvent(it.repoFullName);
      // GitHub can be configured to send form-encoded bodies; those verify but are not supported.
      const notJson = await deliver(it, it.webhookSecret, body, {
        contentType: 'application/x-www-form-urlencoded',
        raw: `payload=${encodeURIComponent(JSON.stringify(body))}`,
      });
      expect(notJson.status).toBe(400);
      expect(notJson.body.error.code).toBe('UNSUPPORTED_CONTENT_TYPE');
      expect((await deliver(it, it.webhookSecret, body, { delivery: null })).status).toBe(400);
      expect(
        (await deliver(it, it.webhookSecret, body, { delivery: 'bad delivery id!' })).status,
      ).toBe(400);
      expect((await deliver(it, it.webhookSecret, body, { event: 'Not An Event' })).status).toBe(
        400,
      );
    });

    it('answers 404 for unknown and disabled integrations, without revealing which', async () => {
      const it = await connect();
      const body = deploymentEvent(it.repoFullName);
      expect((await deliver({ id: randomUUID() }, it.webhookSecret, body)).status).toBe(404);
      expect((await deliver({ id: 'not-a-uuid' }, it.webhookSecret, body)).status).toBe(404);
      await owner.client.delete(`/orgs/${orgId}/integrations/github/${it.id}`);
      expect((await deliver(it, it.webhookSecret, body)).status).toBe(404);
    });

    it('throttles a source that keeps sending bad signatures, but never blocks valid ones', async () => {
      const it = await connect();
      const body = deploymentEvent(it.repoFullName);
      const ip = randomIp();
      const statuses: number[] = [];
      for (let i = 0; i < 12; i++) {
        statuses.push((await deliver(it, 'wrong-secret', body, { ip })).status);
      }
      expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
      expect(statuses.slice(10)).toEqual([429, 429]);
      // A correctly signed delivery from the same address is still accepted.
      expect((await deliver(it, it.webhookSecret, body, { ip })).status).toBe(202);
    });
  });

  describe('deployments and incidents', () => {
    const seedDeployment = async (
      integrationId: string,
      org: string,
      project: string,
      service: string | null,
      minutesAgo: number,
      over: { status?: 'SUCCESS' | 'FAILURE' } = {},
    ) => {
      const at = new Date(Date.now() - minutesAgo * 60_000);
      return t.prisma.deployment.create({
        data: {
          organizationId: org,
          projectId: project,
          serviceId: service,
          integrationId,
          externalId: randomUUID(),
          environment: 'production',
          ref: 'main',
          commitSha: randomBytes(20).toString('hex'),
          status: over.status ?? 'SUCCESS',
          startedAt: at,
          deployedAt: (over.status ?? 'SUCCESS') === 'SUCCESS' ? at : null,
          statusUpdatedAt: at,
        },
      });
    };

    it('suggests recent successful deployments of the same service, and links them', async () => {
      const it = await connect();
      const otherService = (await createService(owner, orgId, projectId, 'Other service')).id;
      const recent = await seedDeployment(it.id, orgId, projectId, serviceId, 30);
      const old = await seedDeployment(it.id, orgId, projectId, serviceId, 60 * 5);
      const failed = await seedDeployment(it.id, orgId, projectId, serviceId, 20, {
        status: 'FAILURE',
      });
      const elsewhere = await seedDeployment(it.id, orgId, projectId, otherService, 10);
      const incident = await createIncident(owner, orgId, { serviceId });

      const before = await owner.client.get(`/orgs/${orgId}/incidents/${incident.id}/deployments`);
      expect(before.status).toBe(200);
      const suggested = (before.body as IncidentDeploymentsDto).suggested.map((d) => d.id);
      expect(suggested).toContain(recent.id);
      for (const excluded of [old.id, failed.id, elsewhere.id]) {
        expect(suggested).not.toContain(excluded);
      }
      expect((before.body as IncidentDeploymentsDto).linked).toEqual([]);

      const link = await owner.client.post(`/orgs/${orgId}/incidents/${incident.id}/deployments`, {
        deploymentId: recent.id,
        relation: 'CONFIRMED',
      });
      expect(link.status).toBe(201);
      expect(link.body).toMatchObject({ relation: 'CONFIRMED', deployment: { id: recent.id } });

      const after = (await owner.client.get(`/orgs/${orgId}/incidents/${incident.id}/deployments`))
        .body as IncidentDeploymentsDto;
      expect(after.linked.map((l) => l.deployment.id)).toEqual([recent.id]);
      expect(after.suggested.map((d) => d.id)).not.toContain(recent.id);

      const events = await t.prisma.incidentEvent.findMany({
        where: { incidentId: incident.id, type: 'DEPLOYMENT_LINKED' },
      });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ actorType: 'USER', actorId: owner.id });
      expect(events[0]!.data).toMatchObject({ deploymentId: recent.id, relation: 'CONFIRMED' });

      const again = await owner.client.post(`/orgs/${orgId}/incidents/${incident.id}/deployments`, {
        deploymentId: recent.id,
      });
      expect(again.status).toBe(409);
      expect(again.body.error.code).toBe('ALREADY_LINKED');
    });

    it.each(ROLES)('%s: linking a deployment matches the role', async (role) => {
      const it = await connect();
      const deployment = await seedDeployment(it.id, orgId, projectId, serviceId, 5);
      const incident = await createIncident(owner, orgId, { serviceId });
      const res = await actors[role].client.post(
        `/orgs/${orgId}/incidents/${incident.id}/deployments`,
        { deploymentId: deployment.id },
      );
      expect(res.status).toBe(CAN_LINK.includes(role) ? 201 : 403);
      const read = await actors[role].client.get(
        `/orgs/${orgId}/incidents/${incident.id}/deployments`,
      );
      expect(read.status).toBe(200);
    });

    it("never crosses tenants: other organizations' deployments and incidents are invisible", async () => {
      const other = await registerUser(t, 'Tenant B');
      const otherOrg = (await createOrg(other, 'Tenant B Org')).id;
      const otherProject = (await createProject(other, otherOrg)).id;
      const otherService = (await createService(other, otherOrg, otherProject)).id;
      const theirs = await connect(other, otherOrg, {
        projectId: otherProject,
        serviceId: otherService,
      });
      const theirDeployment = await seedDeployment(
        theirs.id,
        otherOrg,
        otherProject,
        otherService,
        5,
      );
      const theirIncident = await createIncident(other, otherOrg, { serviceId: otherService });
      const ourIncident = await createIncident(owner, orgId, { serviceId });

      // Our incident cannot link their deployment.
      const cross = await owner.client.post(
        `/orgs/${orgId}/incidents/${ourIncident.id}/deployments`,
        {
          deploymentId: theirDeployment.id,
        },
      );
      expect(cross.status).toBe(404);
      // We cannot read or link on their incident through our own org path.
      expect(
        (await owner.client.get(`/orgs/${orgId}/incidents/${theirIncident.id}/deployments`)).status,
      ).toBe(404);
      const ours = await seedDeployment((await connect()).id, orgId, projectId, serviceId, 5);
      expect(
        (
          await owner.client.post(`/orgs/${orgId}/incidents/${theirIncident.id}/deployments`, {
            deploymentId: ours.id,
          })
        ).status,
      ).toBe(404);
      // Their deployments never appear in our list.
      const list = await owner.client.get(`/orgs/${orgId}/deployments?limit=100`);
      expect(
        (list.body.data as Array<{ id: string }>).some((d) => d.id === theirDeployment.id),
      ).toBe(false);
      // The database itself refuses a cross-tenant link, whatever the application does.
      await expect(
        t.prisma.incidentDeployment.create({
          data: {
            organizationId: orgId,
            incidentId: ourIncident.id,
            deploymentId: theirDeployment.id,
            relation: 'SUSPECTED',
          },
        }),
      ).rejects.toThrow();
    });

    it('lists deployments newest first, filtered by service', async () => {
      const it = await connect();
      const svc = (
        await createService(owner, orgId, projectId, `Filter ${randomUUID().slice(0, 6)}`)
      ).id;
      const older = await seedDeployment(it.id, orgId, projectId, svc, 50);
      const newer = await seedDeployment(it.id, orgId, projectId, svc, 5);
      const res = await owner.client.get(`/orgs/${orgId}/deployments?serviceId=${svc}`);
      expect(res.status).toBe(200);
      expect((res.body.data as Array<{ id: string }>).map((d) => d.id)).toEqual([
        newer.id,
        older.id,
      ]);
      expect((await owner.client.get(`/orgs/${orgId}/deployments?limit=0`)).status).toBe(400);
    });
  });

  describe('when INTEGRATION_ENCRYPTION_KEY is not configured', () => {
    it('refuses to create integrations and to receive deliveries', async () => {
      const it = await connect(); // created while the key exists
      const bare = await createTestApp({ env: { INTEGRATION_ENCRYPTION_KEY: '' } });
      try {
        const user = await registerUser(bare, 'No Key');
        const org = (await createOrg(user, 'No Key Org')).id;
        const project = (await createProject(user, org)).id;
        const res = await user.client.post(`/orgs/${org}/integrations/github`, {
          repoFullName: repoName(),
          projectId: project,
        });
        expect(res.status).toBe(503);
        expect(res.body.error.code).toBe('INTEGRATIONS_NOT_CONFIGURED');

        const raw = JSON.stringify(deploymentEvent(it.repoFullName));
        const delivery = await request(bare.server)
          .post(`/api/v1/webhooks/github/${it.id}`)
          .set('X-Forwarded-For', randomIp())
          .set('Content-Type', 'application/json')
          .set('X-GitHub-Event', 'deployment_status')
          .set('X-GitHub-Delivery', randomUUID())
          .set('X-Hub-Signature-256', computeGitHubSignature(it.webhookSecret, Buffer.from(raw)))
          .send(raw);
        expect(delivery.status).toBe(503);
      } finally {
        await bare.close();
      }
    });
  });
});
