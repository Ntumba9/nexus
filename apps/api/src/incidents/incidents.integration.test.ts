import { randomUUID } from 'node:crypto';
import type { IncidentDetailDto, IncidentEventDto, IncidentPageDto } from '@nexus/shared';
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

describe.skipIf(!HAS_INFRA)('incident lifecycle (integration)', () => {
  let t: TestApp;
  let owner: TestUser;
  let orgId: string;
  let developer: TestUser & { memberId: string };
  let support: TestUser & { memberId: string };

  const events = async (incidentId: string): Promise<IncidentEventDto[]> =>
    (await owner.client.get(`/orgs/${orgId}/incidents/${incidentId}/events`)).body.data;
  const transition = (incidentId: string, to: string, user: TestUser = owner) =>
    user.client.post(`/orgs/${orgId}/incidents/${incidentId}/transitions`, { to });

  beforeAll(async () => {
    t = await createTestApp();
    owner = await registerUser(t, 'Olivia Owner');
    orgId = (await createOrg(owner, 'Lifecycle Org')).id;
    developer = await userWithRole(t, orgId, 'DEVELOPER');
    support = await userWithRole(t, orgId, 'SUPPORT');
  });
  afterAll(() => t.close());

  describe('creation', () => {
    it('opens an incident with a per-organisation number, OPEN status and a CREATED event', async () => {
      const project = await createProject(owner, orgId);
      const service = await createService(owner, orgId, project.id);
      const incident = await createIncident(owner, orgId, {
        title: 'Checkout is failing',
        severity: 'SEV1',
        serviceId: service.id,
        tags: ['Payments', 'checkout', 'payments'],
        description: 'Users see a 500 at payment',
      });

      expect(incident).toMatchObject({
        title: 'Checkout is failing',
        severity: 'SEV1',
        status: 'OPEN',
        source: 'MANUAL',
        description: 'Users see a 500 at payment',
        service: { id: service.id, name: 'API', environment: 'PRODUCTION' },
        tags: ['checkout', 'payments'],
        createdBy: { id: owner.id },
        assignees: [],
        acknowledgedAt: null,
        resolvedAt: null,
      });
      expect(incident.number).toBeGreaterThan(0);
      expect(incident.allowedTransitions).toEqual(['ACKNOWLEDGED', 'CANCELLED']);

      const timeline = await events(incident.id);
      expect(timeline).toHaveLength(1);
      expect(timeline[0]).toMatchObject({
        type: 'CREATED',
        actorType: 'USER',
        actor: { id: owner.id },
        data: { severity: 'SEV1', serviceId: service.id, tags: ['checkout', 'payments'] },
      });
    });

    it('numbers incidents 1, 2, 3… per organisation, independently and without gaps', async () => {
      const a = await registerUser(t);
      const b = await registerUser(t);
      const orgA = (await createOrg(a)).id;
      const orgB = (await createOrg(b)).id;
      const numbers = async (user: TestUser, org: string, count: number) => {
        const out: number[] = [];
        for (let i = 0; i < count; i++) out.push((await createIncident(user, org)).number);
        return out;
      };
      expect(await numbers(a, orgA, 3)).toEqual([1, 2, 3]);
      expect(await numbers(b, orgB, 2)).toEqual([1, 2]);
    });

    it('allocates unique numbers under concurrent creation', async () => {
      const user = await registerUser(t);
      const org = (await createOrg(user)).id;
      const created = await Promise.all(Array.from({ length: 8 }, () => createIncident(user, org)));
      expect(created.map((i) => i.number).sort((x, y) => x - y)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    });

    it('rejects invalid input with field details', async () => {
      const cases: Array<[string, Record<string, unknown>]> = [
        ['title', { title: '', severity: 'SEV1' }],
        ['severity', { title: 'x', severity: 'CRITICAL' }],
        ['severity', { title: 'x', severity: 'SEV-1' }],
        ['serviceId', { title: 'x', severity: 'SEV1', serviceId: 'nope' }],
        ['tags', { title: 'x', severity: 'SEV1', tags: ['Not Valid!'] }],
      ];
      for (const [field, body] of cases) {
        const res = await owner.client.post(`/orgs/${orgId}/incidents`, body);
        expect(res.status, JSON.stringify(body)).toBe(400);
        expect(res.body.error.details.map((d: { path: string }) => d.path.split('.')[0])).toContain(
          field,
        );
      }
    });

    it('404s for an unknown or archived service, creating nothing', async () => {
      const project = await createProject(owner, orgId, 'Archive Me');
      const service = await createService(owner, orgId, project.id, 'Doomed');
      await owner.client.delete(`/orgs/${orgId}/services/${service.id}`);
      for (const serviceId of [randomUUID(), service.id]) {
        const res = await owner.client.post(`/orgs/${orgId}/incidents`, {
          title: 'x',
          severity: 'SEV3',
          serviceId,
        });
        expect(res.status).toBe(404);
      }
    });
  });

  describe('status transitions', () => {
    it('walks the full lifecycle, stamping timestamps and recording every step', async () => {
      const incident = await createIncident(owner, orgId);
      const ack = await moveTo(owner, orgId, incident.id, ['ACKNOWLEDGED']);
      expect(ack.acknowledgedAt).not.toBeNull();
      expect(ack.allowedTransitions).toEqual([
        'INVESTIGATING',
        'MITIGATED',
        'RESOLVED',
        'CANCELLED',
      ]);

      const mitigated = await moveTo(owner, orgId, incident.id, ['INVESTIGATING', 'MITIGATED']);
      expect(mitigated.mitigatedAt).not.toBeNull();
      expect(mitigated.resolvedAt).toBeNull();

      const resolved = await moveTo(owner, orgId, incident.id, ['RESOLVED']);
      expect(resolved.status).toBe('RESOLVED');
      expect(resolved.resolvedAt).not.toBeNull();
      expect(resolved.allowedTransitions).toEqual(['INVESTIGATING']); // reopen only

      const statusEvents = (await events(incident.id)).filter((e) => e.type === 'STATUS_CHANGED');
      expect(statusEvents.map((e) => [e.data.from, e.data.to])).toEqual([
        ['OPEN', 'ACKNOWLEDGED'],
        ['ACKNOWLEDGED', 'INVESTIGATING'],
        ['INVESTIGATING', 'MITIGATED'],
        ['MITIGATED', 'RESOLVED'],
      ]);
    });

    it('stores the optional note on the timeline event', async () => {
      const incident = await createIncident(owner, orgId);
      await owner.client.post(`/orgs/${orgId}/incidents/${incident.id}/transitions`, {
        to: 'ACKNOWLEDGED',
        note: 'On it',
      });
      const last = (await events(incident.id)).at(-1)!;
      expect(last.data).toMatchObject({ from: 'OPEN', to: 'ACKNOWLEDGED', note: 'On it' });
    });

    it('reopening a resolved incident clears resolvedAt and is recorded', async () => {
      const incident = await createIncident(owner, orgId);
      await moveTo(owner, orgId, incident.id, ['ACKNOWLEDGED', 'RESOLVED']);
      const reopened = await moveTo(owner, orgId, incident.id, ['INVESTIGATING']);
      expect(reopened.status).toBe('INVESTIGATING');
      expect(reopened.resolvedAt).toBeNull();
      expect((await events(incident.id)).at(-1)!.data).toMatchObject({
        from: 'RESOLVED',
        to: 'INVESTIGATING',
      });
    });

    it('cancelling is terminal', async () => {
      const incident = await createIncident(owner, orgId);
      const cancelled = await moveTo(owner, orgId, incident.id, ['CANCELLED']);
      expect(cancelled.allowedTransitions).toEqual([]);
      for (const to of ['OPEN', 'ACKNOWLEDGED', 'RESOLVED', 'INVESTIGATING']) {
        const res = await transition(incident.id, to);
        expect(res.status, to).toBe(409);
        expect(res.body.error.code).toBe('INVALID_TRANSITION');
      }
    });

    it('rejects illegal jumps and no-op transitions with 409 INVALID_TRANSITION, changing nothing', async () => {
      const incident = await createIncident(owner, orgId);
      for (const to of ['RESOLVED', 'MITIGATED', 'INVESTIGATING', 'OPEN']) {
        const res = await transition(incident.id, to);
        expect(res.status, `OPEN → ${to}`).toBe(409);
        expect(res.body.error.code).toBe('INVALID_TRANSITION');
      }
      expect((await owner.client.get(`/orgs/${orgId}/incidents/${incident.id}`)).body.status).toBe(
        'OPEN',
      );
      expect((await events(incident.id)).filter((e) => e.type === 'STATUS_CHANGED')).toHaveLength(
        0,
      );
    });

    it('rejects unknown statuses with 400', async () => {
      const incident = await createIncident(owner, orgId);
      expect((await transition(incident.id, 'DONE')).status).toBe(400);
    });

    it('lets exactly one of two simultaneous identical transitions succeed', async () => {
      const incident = await createIncident(owner, orgId);
      const results = await Promise.all([
        transition(incident.id, 'ACKNOWLEDGED'),
        transition(incident.id, 'ACKNOWLEDGED', developer),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      expect((await events(incident.id)).filter((e) => e.type === 'STATUS_CHANGED')).toHaveLength(
        1,
      );
    });

    it('requires incidents.resolve to resolve or reopen, but not to move along', async () => {
      const incident = await createIncident(owner, orgId);
      expect((await transition(incident.id, 'ACKNOWLEDGED', support)).status).toBe(200);
      expect((await transition(incident.id, 'INVESTIGATING', support)).status).toBe(200);

      const denied = await transition(incident.id, 'RESOLVED', support);
      expect(denied.status).toBe(403);
      expect(denied.body.error.code).toBe('FORBIDDEN');
      expect((await owner.client.get(`/orgs/${orgId}/incidents/${incident.id}`)).body.status).toBe(
        'INVESTIGATING',
      );

      expect((await transition(incident.id, 'RESOLVED', developer)).status).toBe(200);
      expect((await transition(incident.id, 'INVESTIGATING', support)).status).toBe(403); // reopen
      expect((await transition(incident.id, 'INVESTIGATING', developer)).status).toBe(200);
    });

    it('reports only the transitions the caller is actually allowed to make', async () => {
      const incident = await createIncident(owner, orgId);
      await moveTo(owner, orgId, incident.id, ['ACKNOWLEDGED', 'INVESTIGATING']);
      const asSupport = (await support.client.get(`/orgs/${orgId}/incidents/${incident.id}`))
        .body as IncidentDetailDto;
      const asDeveloper = (await developer.client.get(`/orgs/${orgId}/incidents/${incident.id}`))
        .body as IncidentDetailDto;
      expect(asSupport.allowedTransitions).toEqual(['MITIGATED', 'CANCELLED']);
      expect(asDeveloper.allowedTransitions).toEqual(['MITIGATED', 'RESOLVED', 'CANCELLED']);
    });
  });

  describe('editing', () => {
    it('records severity changes and other edits as separate events', async () => {
      const incident = await createIncident(owner, orgId, { severity: 'SEV3', tags: ['a', 'b'] });
      const res = await owner.client.patch(`/orgs/${orgId}/incidents/${incident.id}`, {
        severity: 'SEV1',
        title: 'Now critical',
        tags: ['b', 'c'],
      });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ severity: 'SEV1', title: 'Now critical', tags: ['b', 'c'] });

      const timeline = await events(incident.id);
      const severity = timeline.find((e) => e.type === 'SEVERITY_CHANGED')!;
      expect(severity.data).toEqual({ from: 'SEV3', to: 'SEV1' });
      const updated = timeline.find((e) => e.type === 'UPDATED')!;
      expect(updated.data.fields).toEqual(expect.arrayContaining(['title', 'tags']));
    });

    it('records nothing when nothing actually changes', async () => {
      const incident = await createIncident(owner, orgId, { title: 'Same', severity: 'SEV2' });
      const before = (await events(incident.id)).length;
      const res = await owner.client.patch(`/orgs/${orgId}/incidents/${incident.id}`, {
        title: 'Same',
        severity: 'SEV2',
      });
      expect(res.status).toBe(200);
      expect((await events(incident.id)).length).toBe(before);
    });

    it('rejects empty updates and invalid values', async () => {
      const incident = await createIncident(owner, orgId);
      expect((await owner.client.patch(`/orgs/${orgId}/incidents/${incident.id}`, {})).status).toBe(
        400,
      );
      expect(
        (await owner.client.patch(`/orgs/${orgId}/incidents/${incident.id}`, { severity: 'P1' }))
          .status,
      ).toBe(400);
    });
  });

  describe('comments', () => {
    it('adds a comment to the timeline with its author and body', async () => {
      const incident = await createIncident(owner, orgId);
      const res = await developer.client.post(`/orgs/${orgId}/incidents/${incident.id}/comments`, {
        body: 'Rolled back v1.4.3',
      });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        type: 'COMMENT_ADDED',
        actor: { id: developer.id },
        data: { body: 'Rolled back v1.4.3' },
      });
      const stored = await t.prisma.incidentComment.findMany({
        where: { incidentId: incident.id },
      });
      expect(stored).toHaveLength(1);
      expect(stored[0]).toMatchObject({ authorId: developer.id, body: 'Rolled back v1.4.3' });
    });

    it('validates comment bodies and still allows post-incident comments', async () => {
      const incident = await createIncident(owner, orgId);
      const url = `/orgs/${orgId}/incidents/${incident.id}/comments`;
      expect((await owner.client.post(url, { body: '   ' })).status).toBe(400);
      expect((await owner.client.post(url, { body: 'x'.repeat(5001) })).status).toBe(400);
      await moveTo(owner, orgId, incident.id, ['ACKNOWLEDGED', 'RESOLVED']);
      expect((await owner.client.post(url, { body: 'Post-mortem: ...' })).status).toBe(201);
    });
  });

  describe('assignments', () => {
    it('assigns and unassigns members, recording who and when', async () => {
      const incident = await createIncident(owner, orgId);
      const url = `/orgs/${orgId}/incidents/${incident.id}/assignees`;

      const assigned = await owner.client.send('put', url, {
        body: { userIds: [developer.id, support.id] },
      });
      expect(assigned.status).toBe(200);
      expect(assigned.body.assignees.map((a: { id: string }) => a.id).sort()).toEqual(
        [developer.id, support.id].sort(),
      );

      const reduced = await owner.client.send('put', url, { body: { userIds: [support.id] } });
      expect(reduced.body.assignees.map((a: { id: string }) => a.id)).toEqual([support.id]);

      const timeline = await events(incident.id);
      expect(timeline.filter((e) => e.type === 'ASSIGNED')).toHaveLength(2);
      const removed = timeline.filter((e) => e.type === 'UNASSIGNED');
      expect(removed).toHaveLength(1);
      expect(removed[0]!.data.userId).toBe(developer.id);

      // History is kept: the ended assignment is closed, not deleted.
      const rows = await t.prisma.incidentAssignment.findMany({
        where: { incidentId: incident.id, userId: developer.id },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]!.unassignedAt).not.toBeNull();
    });

    it('is idempotent: submitting the same set records nothing new', async () => {
      const incident = await createIncident(owner, orgId);
      const url = `/orgs/${orgId}/incidents/${incident.id}/assignees`;
      await owner.client.send('put', url, { body: { userIds: [developer.id] } });
      const before = (await events(incident.id)).length;
      await owner.client.send('put', url, { body: { userIds: [developer.id, developer.id] } });
      expect((await events(incident.id)).length).toBe(before);
    });

    it('can re-assign someone after they were unassigned', async () => {
      const incident = await createIncident(owner, orgId);
      const url = `/orgs/${orgId}/incidents/${incident.id}/assignees`;
      await owner.client.send('put', url, { body: { userIds: [developer.id] } });
      await owner.client.send('put', url, { body: { userIds: [] } });
      const again = await owner.client.send('put', url, { body: { userIds: [developer.id] } });
      expect(again.status).toBe(200);
      expect(again.body.assignees).toHaveLength(1);
    });

    it('rejects users who are not members of this organisation', async () => {
      const incident = await createIncident(owner, orgId);
      const stranger = await registerUser(t);
      const res = await owner.client.send(
        'put',
        `/orgs/${orgId}/incidents/${incident.id}/assignees`,
        {
          body: { userIds: [developer.id, stranger.id] },
        },
      );
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('ASSIGNEE_NOT_MEMBER');
      expect(
        (await owner.client.get(`/orgs/${orgId}/incidents/${incident.id}`)).body.assignees,
      ).toEqual([]);
    });

    it('validates the payload', async () => {
      const incident = await createIncident(owner, orgId);
      const url = `/orgs/${orgId}/incidents/${incident.id}/assignees`;
      expect((await owner.client.send('put', url, { body: { userIds: ['nope'] } })).status).toBe(
        400,
      );
      expect((await owner.client.send('put', url, { body: {} })).status).toBe(400);
    });
  });

  describe('listing and search', () => {
    let listOrg: string;
    let lister: TestUser;
    beforeAll(async () => {
      lister = await registerUser(t);
      listOrg = (await createOrg(lister, 'List Org')).id;
      const project = await createProject(lister, listOrg);
      const service = await createService(lister, listOrg, project.id, 'Auth');
      await createIncident(lister, listOrg, {
        title: 'Database connection pool exhausted',
        severity: 'SEV1',
      }); // #1
      await createIncident(lister, listOrg, {
        title: 'Authentication outage',
        severity: 'SEV2',
        serviceId: service.id,
      }); // #2
      const third = await createIncident(lister, listOrg, {
        title: 'Email degradation',
        severity: 'SEV3',
      }); // #3
      await createIncident(lister, listOrg, { title: 'Slow dashboard', severity: 'SEV4' }); // #4
      await createIncident(lister, listOrg, { title: 'Cache miss storm', severity: 'SEV3' }); // #5
      await moveTo(lister, listOrg, third.id, ['ACKNOWLEDGED', 'RESOLVED']);
    });
    const list = async (query: string): Promise<IncidentPageDto> =>
      (await lister.client.get(`/orgs/${listOrg}/incidents${query}`)).body;

    it('returns newest first', async () => {
      const page = await list('');
      expect(page.data.map((i) => i.number)).toEqual([5, 4, 3, 2, 1]);
      expect(page.nextCursor).toBeNull();
    });

    it('paginates with a cursor without skipping or repeating', async () => {
      const first = await list('?limit=2');
      expect(first.data.map((i) => i.number)).toEqual([5, 4]);
      expect(first.nextCursor).toBe(4);
      const second = await list(`?limit=2&cursor=${first.nextCursor}`);
      expect(second.data.map((i) => i.number)).toEqual([3, 2]);
      const third = await list(`?limit=2&cursor=${second.nextCursor}`);
      expect(third.data.map((i) => i.number)).toEqual([1]);
      expect(third.nextCursor).toBeNull();
    });

    it('filters by status, severity, service and combinations', async () => {
      expect((await list('?status=RESOLVED')).data.map((i) => i.number)).toEqual([3]);
      expect((await list('?status=OPEN,RESOLVED')).data).toHaveLength(5);
      expect((await list('?severity=SEV3')).data.map((i) => i.number)).toEqual([5, 3]);
      expect((await list('?severity=SEV3&status=OPEN')).data.map((i) => i.number)).toEqual([5]);
      const service = (await lister.client.get(`/orgs/${listOrg}/services`)).body.data[0];
      expect((await list(`?serviceId=${service.id}`)).data.map((i) => i.number)).toEqual([2]);
    });

    it('searches titles case-insensitively and by incident number', async () => {
      expect((await list('?q=authentication')).data.map((i) => i.number)).toEqual([2]);
      expect((await list('?q=STORM')).data.map((i) => i.number)).toEqual([5]);
      expect((await list('?q=4')).data.map((i) => i.number)).toContain(4);
      expect((await list('?q=INC-2')).data.map((i) => i.number)).toContain(2);
      expect((await list('?q=zzzz-no-match')).data).toEqual([]);
    });

    it('rejects invalid filters', async () => {
      for (const query of [
        '?status=NOPE',
        '?severity=SEV9',
        '?limit=0',
        '?limit=101',
        '?serviceId=x',
        '?cursor=abc',
      ]) {
        expect((await lister.client.get(`/orgs/${listOrg}/incidents${query}`)).status, query).toBe(
          400,
        );
      }
    });

    it('treats search text as data, not SQL', async () => {
      const res = await lister.client.get(
        `/orgs/${listOrg}/incidents?q=${encodeURIComponent('\'; DROP TABLE "Incident"; --')}`,
      );
      expect(res.status).toBe(200);
      expect((await list('')).data).toHaveLength(5);
    });
  });

  it('returns 404 for unknown and malformed incident ids on every route', async () => {
    const base = `/orgs/${orgId}/incidents`;
    for (const id of [randomUUID(), 'not-a-uuid']) {
      expect((await owner.client.get(`${base}/${id}`)).status).toBe(404);
      expect((await owner.client.patch(`${base}/${id}`, { title: 'x' })).status).toBe(404);
      expect(
        (await owner.client.post(`${base}/${id}/transitions`, { to: 'ACKNOWLEDGED' })).status,
      ).toBe(404);
      expect((await owner.client.get(`${base}/${id}/events`)).status).toBe(404);
      expect((await owner.client.post(`${base}/${id}/comments`, { body: 'x' })).status).toBe(404);
      expect(
        (await owner.client.send('put', `${base}/${id}/assignees`, { body: { userIds: [] } }))
          .status,
      ).toBe(404);
    }
  });
});
