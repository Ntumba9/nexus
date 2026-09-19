import { randomUUID } from 'node:crypto';
import type { MonitoringCheckDto, Role } from '@nexus/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createProject, createService } from '../testing/fixtures';
import {
  HAS_INFRA,
  createOrg,
  createTestApp,
  registerUser,
  userWithRole,
  type TestApp,
  type TestUser,
} from '../testing/harness';

const ROLES: Role[] = ['OWNER', 'ADMIN', 'DEVELOPER', 'SUPPORT', 'VIEWER'];
/** Hand-written expectations, independent of the shared permission map. */
const CAN_MANAGE: Role[] = ['OWNER', 'ADMIN', 'DEVELOPER'];
const URL_OK = 'http://127.0.0.1:4100/health';

async function makeCheck(
  user: TestUser,
  orgId: string,
  serviceId: string,
  overrides: Record<string, unknown> = {},
): Promise<MonitoringCheckDto> {
  const res = await user.client.post(`/orgs/${orgId}/services/${serviceId}/checks`, {
    name: 'Health endpoint',
    url: URL_OK,
    ...overrides,
  });
  if (res.status !== 201)
    throw new Error(`create check failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body as MonitoringCheckDto;
}

describe.skipIf(!HAS_INFRA)('monitoring checks (integration)', () => {
  let t: TestApp;
  let owner: TestUser;
  let orgId: string;
  let serviceId: string;
  const actors = {} as Record<Role, TestUser & { memberId: string }>;

  beforeAll(async () => {
    // Operator opt-in so checks can point at local addresses in tests.
    t = await createTestApp({ env: { MONITORING_ALLOW_PRIVATE_NETWORKS: 'true' } });
    owner = await registerUser(t, 'Monitor Owner');
    orgId = (await createOrg(owner, 'Monitoring Org')).id;
    const project = await createProject(owner, orgId);
    serviceId = (await createService(owner, orgId, project.id, 'Primary API')).id;
    for (const role of ROLES) actors[role] = await userWithRole(t, orgId, role);
  });
  afterAll(() => t.close());

  const freshService = async (name: string) => {
    const project = await createProject(owner, orgId, `P ${name}`);
    return (await createService(owner, orgId, project.id, name)).id;
  };

  describe('management', () => {
    it('creates a check with safe defaults, and lists and reads it back', async () => {
      const check = await makeCheck(owner, orgId, serviceId, { name: 'Production API' });
      expect(check).toMatchObject({
        serviceId,
        name: 'Production API',
        type: 'HTTP',
        expectedStatus: 200,
        timeoutMs: 5000,
        intervalSeconds: 60,
        failureThreshold: 3,
        recoveryThreshold: 2,
        incidentSeverity: 'SEV2',
        createIncidents: true,
        enabled: true,
        healthStatus: 'UNKNOWN',
        consecutiveFailures: 0,
        lastCheckedAt: null,
      });
      const list = await owner.client.get(`/orgs/${orgId}/services/${serviceId}/checks`);
      expect(list.body.data.map((c: { id: string }) => c.id)).toContain(check.id);
      expect((await owner.client.get(`/orgs/${orgId}/checks/${check.id}`)).body.id).toBe(check.id);
    });

    it('a new check is due immediately, so the dispatcher picks it up on its next tick', async () => {
      const check = await makeCheck(owner, orgId, await freshService('due'));
      expect(Date.parse(check.nextRunAt)).toBeLessThanOrEqual(Date.now() + 2000);
    });

    it('validates every setting with field-level errors', async () => {
      const service = await freshService('validation');
      const cases: Array<[string, Record<string, unknown>]> = [
        ['name', { name: '' }],
        ['intervalSeconds', { intervalSeconds: 5 }],
        ['intervalSeconds', { intervalSeconds: 999_999 }],
        ['timeoutMs', { timeoutMs: 10 }],
        ['timeoutMs', { timeoutMs: 60_000 }],
        ['failureThreshold', { failureThreshold: 0 }],
        ['recoveryThreshold', { recoveryThreshold: 99 }],
        ['expectedStatus', { expectedStatus: 700 }],
        ['incidentSeverity', { incidentSeverity: 'SEV-1' }],
        ['intervalSeconds', { intervalSeconds: '60' }],
      ];
      for (const [field, extra] of cases) {
        const res = await owner.client.post(`/orgs/${orgId}/services/${service}/checks`, {
          name: 'x',
          url: URL_OK,
          ...extra,
        });
        expect(res.status, JSON.stringify(extra)).toBe(400);
        expect(res.body.error.code).toBe('VALIDATION_FAILED');
        expect(res.body.error.details.map((d: { path: string }) => d.path)).toContain(field);
      }
    });

    it('updates settings, and resets the verdict when the target changes', async () => {
      const service = await freshService('reset');
      const check = await makeCheck(owner, orgId, service);
      await t.prisma.monitoringCheck.update({
        where: { id: check.id },
        data: { healthStatus: 'DOWN', consecutiveFailures: 4, consecutiveSuccesses: 0 },
      });
      await t.prisma.service.update({ where: { id: service }, data: { healthStatus: 'DOWN' } });

      const rename = await owner.client.patch(`/orgs/${orgId}/checks/${check.id}`, {
        name: 'Renamed',
        failureThreshold: 5,
      });
      expect(rename.status).toBe(200);
      expect(rename.body).toMatchObject({
        name: 'Renamed',
        failureThreshold: 5,
        healthStatus: 'DOWN',
        consecutiveFailures: 4,
      });

      const retarget = await owner.client.patch(`/orgs/${orgId}/checks/${check.id}`, {
        url: 'http://127.0.0.1:4100/other',
      });
      expect(retarget.body).toMatchObject({ healthStatus: 'UNKNOWN', consecutiveFailures: 0 });
      expect(
        (await t.prisma.service.findUniqueOrThrow({ where: { id: service } })).healthStatus,
      ).toBe('UNKNOWN');
      expect((await owner.client.patch(`/orgs/${orgId}/checks/${check.id}`, {})).status).toBe(400);
    });

    it('disabling a check stops it counting towards service health; enabling makes it due again', async () => {
      const service = await freshService('toggle');
      const check = await makeCheck(owner, orgId, service);
      await t.prisma.monitoringCheck.update({
        where: { id: check.id },
        data: { healthStatus: 'HEALTHY' },
      });
      await t.prisma.service.update({ where: { id: service }, data: { healthStatus: 'HEALTHY' } });

      await owner.client.patch(`/orgs/${orgId}/checks/${check.id}`, { enabled: false });
      expect(
        (await t.prisma.service.findUniqueOrThrow({ where: { id: service } })).healthStatus,
      ).toBe('UNKNOWN'); // not monitored

      const enabled = await owner.client.patch(`/orgs/${orgId}/checks/${check.id}`, {
        enabled: true,
      });
      expect(Date.parse(enabled.body.nextRunAt)).toBeLessThanOrEqual(Date.now() + 2000);
    });

    it('deleting a check removes its results and recomputes service health', async () => {
      const service = await freshService('delete');
      const check = await makeCheck(owner, orgId, service);
      await t.prisma.monitoringCheck.update({
        where: { id: check.id },
        data: { healthStatus: 'DOWN' },
      });
      await t.prisma.service.update({ where: { id: service }, data: { healthStatus: 'DOWN' } });
      await t.prisma.monitoringResult.create({
        data: {
          organizationId: orgId,
          checkId: check.id,
          status: 'UP',
          scheduledFor: new Date(),
          statusCode: 200,
          responseTimeMs: 4,
        },
      });

      expect((await owner.client.delete(`/orgs/${orgId}/checks/${check.id}`)).status).toBe(204);
      expect((await owner.client.get(`/orgs/${orgId}/checks/${check.id}`)).status).toBe(404);
      expect(await t.prisma.monitoringResult.count({ where: { checkId: check.id } })).toBe(0);
      expect(
        (await t.prisma.service.findUniqueOrThrow({ where: { id: service } })).healthStatus,
      ).toBe('UNKNOWN');
    });

    it('limits the number of checks per service', async () => {
      const service = await freshService('limit');
      for (let i = 0; i < 5; i++) await makeCheck(owner, orgId, service, { name: `c${i}` });
      const sixth = await owner.client.post(`/orgs/${orgId}/services/${service}/checks`, {
        name: 'c5',
        url: URL_OK,
      });
      expect(sixth.status).toBe(409);
      expect(sixth.body.error.code).toBe('CHECK_LIMIT');
    });

    it('refuses checks on archived services', async () => {
      const service = await freshService('archived');
      await owner.client.delete(`/orgs/${orgId}/services/${service}`);
      const res = await owner.client.post(`/orgs/${orgId}/services/${service}/checks`, {
        name: 'x',
        url: URL_OK,
      });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('SERVICE_ARCHIVED');
    });

    it('404s for unknown and malformed ids', async () => {
      for (const id of [randomUUID(), 'nope']) {
        expect((await owner.client.get(`/orgs/${orgId}/checks/${id}`)).status).toBe(404);
        expect(
          (await owner.client.patch(`/orgs/${orgId}/checks/${id}`, { enabled: false })).status,
        ).toBe(404);
        expect((await owner.client.delete(`/orgs/${orgId}/checks/${id}`)).status).toBe(404);
        expect((await owner.client.post(`/orgs/${orgId}/checks/${id}/run`)).status).toBe(404);
        expect((await owner.client.get(`/orgs/${orgId}/checks/${id}/results`)).status).toBe(404);
        expect((await owner.client.get(`/orgs/${orgId}/services/${id}/checks`)).status).toBe(404);
      }
    });
  });

  describe('run now', () => {
    it('schedules the check immediately (asynchronously) and refuses disabled checks', async () => {
      const check = await makeCheck(owner, orgId, await freshService('run'));
      await t.prisma.monitoringCheck.update({
        where: { id: check.id },
        data: { nextRunAt: new Date(Date.now() + 3_600_000) },
      });

      const res = await owner.client.post(`/orgs/${orgId}/checks/${check.id}/run`);
      expect(res.status).toBe(202);
      expect(res.body).toEqual({ status: 'scheduled' });
      const row = await t.prisma.monitoringCheck.findUniqueOrThrow({ where: { id: check.id } });
      expect(row.nextRunAt.getTime()).toBeLessThanOrEqual(Date.now() + 1000);

      await owner.client.patch(`/orgs/${orgId}/checks/${check.id}`, { enabled: false });
      const disabled = await owner.client.post(`/orgs/${orgId}/checks/${check.id}/run`);
      expect(disabled.status).toBe(409);
      expect(disabled.body.error.code).toBe('CHECK_DISABLED');
    });
  });

  describe('results', () => {
    it('lists results newest first with stable pagination', async () => {
      const check = await makeCheck(owner, orgId, await freshService('results'));
      const base = Date.now() - 3_600_000;
      await t.prisma.monitoringResult.createMany({
        data: Array.from({ length: 12 }, (_, i) => ({
          organizationId: orgId,
          checkId: check.id,
          status: i % 4 === 3 ? ('DOWN' as const) : ('UP' as const),
          statusCode: i % 4 === 3 ? 503 : 200,
          responseTimeMs: 10 + i,
          failureReason: i % 4 === 3 ? 'unexpected_status' : null,
          scheduledFor: new Date(base + i * 60_000),
          checkedAt: new Date(base + i * 60_000),
        })),
      });

      const first = await owner.client.get(`/orgs/${orgId}/checks/${check.id}/results?limit=5`);
      expect(first.status).toBe(200);
      expect(first.body.data.map((r: { responseTimeMs: number }) => r.responseTimeMs)).toEqual([
        21, 20, 19, 18, 17,
      ]);
      expect(first.body.data[0]).toMatchObject({
        status: 'DOWN',
        statusCode: 503,
        failureReason: 'unexpected_status',
      });
      expect(first.body.nextBefore).not.toBeNull();

      const second = await owner.client.get(
        `/orgs/${orgId}/checks/${check.id}/results?limit=5&before=${encodeURIComponent(first.body.nextBefore)}`,
      );
      expect(second.body.data.map((r: { responseTimeMs: number }) => r.responseTimeMs)).toEqual([
        16, 15, 14, 13, 12,
      ]);
      const third = await owner.client.get(
        `/orgs/${orgId}/checks/${check.id}/results?limit=5&before=${encodeURIComponent(second.body.nextBefore)}`,
      );
      expect(third.body.data).toHaveLength(2);
      expect(third.body.nextBefore).toBeNull();
    });

    it('validates paging parameters', async () => {
      const check = await makeCheck(owner, orgId, await freshService('paging'));
      for (const query of ['limit=0', 'limit=201', 'before=yesterday']) {
        expect(
          (await owner.client.get(`/orgs/${orgId}/checks/${check.id}/results?${query}`)).status,
          query,
        ).toBe(400);
      }
    });
  });

  describe.each(ROLES)('%s: permission matrix over HTTP', (role) => {
    const actor = () => actors[role];
    const allowed = CAN_MANAGE.includes(role);

    it('reads checks and results (every role)', async () => {
      const service = await freshService(`read-${role}`);
      const check = await makeCheck(owner, orgId, service);
      for (const path of [
        `/services/${service}/checks`,
        `/checks/${check.id}`,
        `/checks/${check.id}/results`,
      ]) {
        expect((await actor().client.get(`/orgs/${orgId}${path}`)).status, path).toBe(200);
      }
    });

    it('services.manage: create, update, run and delete', async () => {
      const service = await freshService(`write-${role}`);
      const existing = await makeCheck(owner, orgId, service, { name: 'existing' });
      const create = await actor().client.post(`/orgs/${orgId}/services/${service}/checks`, {
        name: `by ${role}`,
        url: URL_OK,
      });
      const patch = await actor().client.patch(`/orgs/${orgId}/checks/${existing.id}`, {
        name: `edited by ${role}`,
      });
      const run = await actor().client.post(`/orgs/${orgId}/checks/${existing.id}/run`);
      const del = await actor().client.delete(`/orgs/${orgId}/checks/${existing.id}`);
      expect([create.status, patch.status, run.status, del.status]).toEqual(
        allowed ? [201, 200, 202, 204] : [403, 403, 403, 403],
      );
      if (!allowed) {
        const untouched = await t.prisma.monitoringCheck.findUniqueOrThrow({
          where: { id: existing.id },
        });
        expect(untouched.name).toBe('existing');
      }
    });
  });

  describe('tenant isolation', () => {
    it("another organisation cannot see or change this organisation's checks", async () => {
      const service = await freshService('isolated');
      const check = await makeCheck(owner, orgId, service, {
        name: 'secret check',
        url: 'http://127.0.0.1:4100/private-path',
      });

      const other = await registerUser(t, 'Other Owner');
      const otherOrg = (await createOrg(other, 'Other Org')).id;
      const otherProject = await createProject(other, otherOrg);
      const otherService = (await createService(other, otherOrg, otherProject.id)).id;

      // Through the other organisation's own path, using this organisation's ids: 404 everywhere.
      const attempts = await Promise.all([
        other.client.get(`/orgs/${otherOrg}/services/${service}/checks`),
        other.client.post(`/orgs/${otherOrg}/services/${service}/checks`, {
          name: 'injected',
          url: URL_OK,
        }),
        other.client.get(`/orgs/${otherOrg}/checks/${check.id}`),
        other.client.patch(`/orgs/${otherOrg}/checks/${check.id}`, {
          enabled: false,
          name: 'hijacked',
        }),
        other.client.delete(`/orgs/${otherOrg}/checks/${check.id}`),
        other.client.post(`/orgs/${otherOrg}/checks/${check.id}/run`),
        other.client.get(`/orgs/${otherOrg}/checks/${check.id}/results`),
      ]);
      for (const res of attempts) {
        expect(res.status).toBe(404);
        expect(JSON.stringify(res.body)).not.toMatch(/secret check|private-path/);
      }
      // Through this organisation's path they are not members: 404 as well.
      expect((await other.client.get(`/orgs/${orgId}/checks/${check.id}`)).status).toBe(404);

      const row = await t.prisma.monitoringCheck.findUniqueOrThrow({ where: { id: check.id } });
      expect(row).toMatchObject({ name: 'secret check', enabled: true });
      expect(await t.prisma.monitoringCheck.count({ where: { serviceId: service } })).toBe(1);
      expect(await t.prisma.monitoringCheck.count({ where: { serviceId: otherService } })).toBe(0);
    });
  });
});

describe.skipIf(!HAS_INFRA)('monitoring URL safety / SSRF (integration)', () => {
  let t: TestApp;
  let owner: TestUser;
  let orgId: string;
  let serviceId: string;

  beforeAll(async () => {
    t = await createTestApp({ env: { MONITORING_ALLOW_PRIVATE_NETWORKS: 'false' } });
    owner = await registerUser(t);
    orgId = (await createOrg(owner)).id;
    const project = await createProject(owner, orgId);
    serviceId = (await createService(owner, orgId, project.id)).id;
  });
  afterAll(() => t.close());

  const create = (url: string) =>
    owner.client.post(`/orgs/${orgId}/services/${serviceId}/checks`, { name: 'x', url });

  it('rejects private, loopback, link-local and metadata addresses', async () => {
    for (const url of [
      'http://127.0.0.1/',
      'http://localhost:3001/health',
      'http://10.0.0.5/',
      'http://192.168.1.1/',
      'http://169.254.169.254/latest/meta-data/',
      'http://[::1]/',
      'http://[fe80::1]/',
      'http://0.0.0.0/',
      'http://2130706433/',
      'http://localhost./',
      'http://db.internal/',
    ]) {
      const res = await create(url);
      expect(res.status, url).toBe(400);
      expect(res.body.error.code, url).toBe('URL_NOT_ALLOWED');
      expect(res.body.error.details[0].path).toBe('url');
    }
    expect(await t.prisma.monitoringCheck.count({ where: { serviceId } })).toBe(0);
  });

  it('rejects other schemes and embedded credentials', async () => {
    for (const url of [
      'ftp://example.com/',
      'file:///etc/passwd',
      'javascript:alert(1)',
      'https://user:pass@example.com/',
      'not a url',
    ]) {
      const res = await create(url);
      expect(res.status, url).toBe(400);
      expect(res.body.error.code, url).toBe('URL_NOT_ALLOWED');
    }
  });

  it('accepts ordinary public URLs (no DNS lookup happens when saving)', async () => {
    const res = await create('https://example.com/health?probe=1');
    expect(res.status).toBe(201);
    expect(res.body.url).toBe('https://example.com/health?probe=1');
  });

  it('applies the same rule when an existing check is edited', async () => {
    const check = (await create('https://example.org/health')).body as MonitoringCheckDto;
    const res = await owner.client.patch(`/orgs/${orgId}/checks/${check.id}`, {
      url: 'http://169.254.169.254/',
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('URL_NOT_ALLOWED');
    expect(
      (await t.prisma.monitoringCheck.findUniqueOrThrow({ where: { id: check.id } })).url,
    ).toBe('https://example.org/health');
  });
});
