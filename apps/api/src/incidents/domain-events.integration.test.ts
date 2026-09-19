import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createIncident, createProject, createService } from '../testing/fixtures';
import {
  HAS_INFRA,
  createOrg,
  createTestApp,
  registerUser,
  type TestApp,
  type TestUser,
} from '../testing/harness';

/**
 * The API has its own write paths (transition, severity, assignment, comment). They all go through
 * the shared incident-event writer, so each one must reach the automation outbox exactly once.
 */
describe.skipIf(!HAS_INFRA)('API changes reach the automation outbox (integration)', () => {
  let t: TestApp;
  let owner: TestUser;
  let orgId: string;
  let serviceId: string;

  beforeAll(async () => {
    t = await createTestApp();
    owner = await registerUser(t, 'Outbox Owner');
    orgId = (await createOrg(owner, 'Outbox Org')).id;
    const project = await createProject(owner, orgId);
    serviceId = (await createService(owner, orgId, project.id, 'Billing API')).id;
  });
  afterAll(() => t.close());

  const events = (incidentId: string) =>
    t.prisma.domainEvent.findMany({
      where: { organizationId: orgId, subjectId: incidentId },
      orderBy: { occurredAt: 'asc' },
    });

  it('creating an incident announces it once, with its service and creator context', async () => {
    const incident = await createIncident(owner, orgId, { title: 'Billing is down', serviceId });
    const found = await events(incident.id);
    expect(found.map((e) => e.type)).toEqual(['incident.created']);
    expect(found[0]!.facts).toMatchObject({
      title: 'Billing is down',
      severity: 'SEV2',
      status: 'OPEN',
      source: 'MANUAL',
      serviceName: 'Billing API',
    });
    expect(found[0]!.causedByExecutionId).toBeNull();
  });

  it('a transition, a severity change and an assignment each announce themselves once', async () => {
    const incident = await createIncident(owner, orgId, { serviceId });

    const transition = await owner.client.post(
      `/orgs/${orgId}/incidents/${incident.id}/transitions`,
      {
        to: 'ACKNOWLEDGED',
      },
    );
    expect(transition.status).toBe(200);
    const patch = await owner.client.patch(`/orgs/${orgId}/incidents/${incident.id}`, {
      severity: 'SEV1',
    });
    expect(patch.status).toBe(200);
    const assign = await owner.client.send(
      'put',
      `/orgs/${orgId}/incidents/${incident.id}/assignees`,
      {
        body: { userIds: [owner.id] },
      },
    );
    expect(assign.status).toBe(200);

    const found = await events(incident.id);
    expect(found.map((e) => e.type)).toEqual([
      'incident.created',
      'incident.status_changed',
      'incident.severity_changed',
      'incident.assigned',
    ]);
    expect(found[1]!.facts).toMatchObject({ fromStatus: 'OPEN', toStatus: 'ACKNOWLEDGED' });
    expect(found[2]!.facts).toMatchObject({ fromSeverity: 'SEV2', toSeverity: 'SEV1' });
    expect(found[3]!.facts).toMatchObject({
      assigneeUserId: owner.id,
      assigneeName: 'Outbox Owner',
    });
  });

  it('comments and other edits stay on the timeline but are not announced', async () => {
    const incident = await createIncident(owner, orgId, { serviceId });
    const comment = await owner.client.post(`/orgs/${orgId}/incidents/${incident.id}/comments`, {
      body: 'Looking into it',
    });
    expect(comment.status).toBe(201);
    const rename = await owner.client.patch(`/orgs/${orgId}/incidents/${incident.id}`, {
      title: 'Renamed',
    });
    expect(rename.status).toBe(200);
    expect((await events(incident.id)).map((e) => e.type)).toEqual(['incident.created']);
  });

  it('a rejected change announces nothing', async () => {
    const incident = await createIncident(owner, orgId, { serviceId });
    // OPEN -> RESOLVED is not a legal shortcut, so nothing may be written or announced.
    const before = (await events(incident.id)).length;
    const res = await owner.client.post(`/orgs/${orgId}/incidents/${incident.id}/transitions`, {
      to: 'OPEN',
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await events(incident.id)).toHaveLength(before);
  });
});
