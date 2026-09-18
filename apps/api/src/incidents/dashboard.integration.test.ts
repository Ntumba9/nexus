import type { DashboardDto } from '@nexus/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createIncident, createProject, createService, moveTo } from '../testing/fixtures';
import {
  HAS_INFRA,
  createOrg,
  createTestApp,
  registerUser,
  userWithRole,
  type TestApp,
  type TestUser,
} from '../testing/harness';

describe.skipIf(!HAS_INFRA)('dashboard (integration)', () => {
  let t: TestApp;
  let owner: TestUser;
  let orgId: string;
  let viewer: TestUser;
  let empty: TestUser;
  let emptyOrgId: string;

  const dashboard = async (user: TestUser = owner, org: string = orgId): Promise<DashboardDto> => {
    const res = await user.client.get(`/orgs/${org}/dashboard`);
    expect(res.status).toBe(200);
    return res.body;
  };

  beforeAll(async () => {
    t = await createTestApp();
    empty = await registerUser(t);
    emptyOrgId = (await createOrg(empty, 'Empty Org')).id;

    owner = await registerUser(t, 'Dash Owner');
    orgId = (await createOrg(owner, 'Dash Org')).id;
    viewer = await userWithRole(t, orgId, 'VIEWER');

    const project = await createProject(owner, orgId);
    const api = await createService(owner, orgId, project.id, 'API');
    await createService(owner, orgId, project.id, 'Database');
    const archived = await createService(owner, orgId, project.id, 'Retired');
    await owner.client.delete(`/orgs/${orgId}/services/${archived.id}`);

    await createIncident(owner, orgId, { title: 'low priority', severity: 'SEV4' }); // #1 OPEN
    const sev1 = await createIncident(owner, orgId, {
      title: 'checkout down',
      severity: 'SEV1',
      serviceId: api.id,
    }); // #2 → INVESTIGATING
    await moveTo(owner, orgId, sev1.id, ['ACKNOWLEDGED', 'INVESTIGATING']);
    await createIncident(owner, orgId, { title: 'slow search', severity: 'SEV3' }); // #3 OPEN
    const done = await createIncident(owner, orgId, { title: 'already fixed', severity: 'SEV2' }); // #4 RESOLVED
    await moveTo(owner, orgId, done.id, ['ACKNOWLEDGED', 'RESOLVED']);
    const cancelled = await createIncident(owner, orgId, {
      title: 'false alarm',
      severity: 'SEV1',
    }); // #5 CANCELLED
    await moveTo(owner, orgId, cancelled.id, ['CANCELLED']);
  });
  afterAll(() => t.close());

  it('counts only ACTIVE incidents (not resolved or cancelled), by severity', async () => {
    const { activeIncidents } = await dashboard();
    expect(activeIncidents.total).toBe(3);
    expect(activeIncidents.bySeverity).toEqual({ SEV1: 1, SEV2: 0, SEV3: 1, SEV4: 1 });
  });

  it('lists the most urgent active incidents first', async () => {
    const { activeIncidents } = await dashboard();
    expect(activeIncidents.items.map((i) => i.title)).toEqual([
      'checkout down',
      'slow search',
      'low priority',
    ]);
    expect(activeIncidents.items[0]).toMatchObject({
      severity: 'SEV1',
      status: 'INVESTIGATING',
      service: { name: 'API' },
    });
  });

  it('shows recent incidents newest first, including resolved and cancelled ones', async () => {
    const { recentIncidents } = await dashboard();
    expect(recentIncidents.map((i) => i.number)).toEqual([5, 4, 3, 2, 1]);
    expect(recentIncidents.map((i) => i.status)).toEqual([
      'CANCELLED',
      'RESOLVED',
      'OPEN',
      'INVESTIGATING',
      'OPEN',
    ]);
  });

  it('reports service health honestly: unmonitored services are UNKNOWN, archived ones are excluded', async () => {
    const { serviceHealth } = await dashboard();
    expect(serviceHealth.total).toBe(2);
    expect(serviceHealth.byStatus).toEqual({ UNKNOWN: 2, HEALTHY: 0, DEGRADED: 0, DOWN: 0 });
    expect(serviceHealth.monitored).toBe(false);
  });

  it('reflects real health once a service has a monitored status', async () => {
    const service = await t.prisma.service.findFirstOrThrow({
      where: { organizationId: orgId, name: 'Database' },
    });
    await t.prisma.service.update({ where: { id: service.id }, data: { healthStatus: 'DOWN' } });
    const { serviceHealth } = await dashboard();
    expect(serviceHealth.byStatus).toMatchObject({ UNKNOWN: 1, DOWN: 1 });
    expect(serviceHealth.monitored).toBe(true);
  });

  it('builds a zero-filled 14-day trend with today’s real counts', async () => {
    const { incidentTrend } = await dashboard();
    expect(incidentTrend).toHaveLength(14);
    const dates = incidentTrend.map((p) => p.date);
    expect([...dates].sort()).toEqual(dates);
    expect(new Set(dates).size).toBe(14);
    expect(incidentTrend.reduce((sum, p) => sum + p.opened, 0)).toBe(5);
    expect(incidentTrend.reduce((sum, p) => sum + p.resolved, 0)).toBe(1);
    expect(incidentTrend.slice(0, 12).every((p) => p.opened === 0 && p.resolved === 0)).toBe(true);
  });

  it('shows recent activity newest first, with incident references and actors', async () => {
    const { recentActivity } = await dashboard();
    expect(recentActivity).toHaveLength(10);
    const times = recentActivity.map((e) => Date.parse(e.createdAt));
    expect([...times].sort((x, y) => y - x)).toEqual(times);
    expect(recentActivity[0]).toMatchObject({
      type: 'STATUS_CHANGED',
      incidentNumber: 5,
      incidentTitle: 'false alarm',
      actorName: 'Dash Owner',
    });
  });

  it('is honest that deployments are not available yet', async () => {
    expect((await dashboard()).recentDeployments).toEqual({ available: false, items: [] });
  });

  it('is readable by a VIEWER', async () => {
    const data = await dashboard(viewer);
    expect(data.activeIncidents.total).toBe(3);
  });

  it('returns clean empty values for an organisation with no data', async () => {
    const data = await dashboard(empty, emptyOrgId);
    expect(data.activeIncidents).toEqual({
      total: 0,
      bySeverity: { SEV1: 0, SEV2: 0, SEV3: 0, SEV4: 0 },
      items: [],
    });
    expect(data.recentIncidents).toEqual([]);
    expect(data.serviceHealth.total).toBe(0);
    expect(data.recentActivity).toEqual([]);
    expect(data.incidentTrend).toHaveLength(14);
  });

  it('is denied to non-members', async () => {
    expect((await empty.client.get(`/orgs/${orgId}/dashboard`)).status).toBe(404);
  });
});
