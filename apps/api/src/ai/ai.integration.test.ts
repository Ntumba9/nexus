import { randomUUID } from 'node:crypto';
import type {
  AiStatusDto,
  AuditLogPageDto,
  InvestigationDto,
  InvestigationOutput,
  Role,
} from '@nexus/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createIncident } from '../testing/fixtures';
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
/** Hand-written expectations, independent of the shared permission map: who may start one. */
const MAY_START: Role[] = ['OWNER', 'ADMIN', 'DEVELOPER', 'SUPPORT'];

const OUTPUT: InvestigationOutput = {
  summary: 'A stored answer.',
  possibleCauses: [
    { description: 'Because', kind: 'evidence', sources: ['INC-EVT-1'], confidence: 'medium' },
  ],
  evidence: [{ statement: 'It was opened', sources: ['INC-EVT-1'] }],
  recommendedInvestigations: [],
  recommendedActions: [],
  confidence: 'medium',
};

describe.skipIf(!HAS_INFRA)('AI investigation API (integration)', () => {
  let t: TestApp;
  let owner: TestUser;
  let orgId: string;
  const actors = {} as Record<Role, TestUser & { memberId: string }>;

  beforeAll(async () => {
    t = await createTestApp({ env: { AI_PROVIDER: 'rules' } });
    owner = await registerUser(t, 'AI Owner');
    orgId = (await createOrg(owner, 'AI Org')).id;
    for (const role of ROLES) actors[role] = await userWithRole(t, orgId, role);
  });
  afterAll(() => t.close());

  const newIncident = async (org = orgId, user: TestUser = owner, title = 'Checkout errors') =>
    (await createIncident(user, org, { title })).id;
  /** Starting is limited per person per hour, so tests that start several use their own person. */
  const person = () => userWithRole(t, orgId, 'ADMIN');
  const start = (user: TestUser, incidentId: string, body: unknown = {}, org = orgId) =>
    user.client.post(`/orgs/${org}/incidents/${incidentId}/investigations`, body);
  const list = (user: TestUser, incidentId: string, org = orgId) =>
    user.client.get(`/orgs/${org}/incidents/${incidentId}/investigations`);

  describe('status', () => {
    it('reports the built-in rule-based analysis to every role', async () => {
      for (const role of ROLES) {
        const res = await actors[role].client.get(`/orgs/${orgId}/ai/status`);
        expect(res.status, role).toBe(200);
        expect(res.body as AiStatusDto).toMatchObject({ available: true, kind: 'rules' });
        expect((res.body as AiStatusDto).label).toMatch(/no AI model/);
      }
    });
    it('requires a session', async () => {
      expect((await owner.client.get(`/orgs/${orgId}/ai/status`, { cookie: null })).status).toBe(
        401,
      );
    });
  });

  describe('permissions', () => {
    for (const role of ROLES) {
      it(`${role}: can read, ${MAY_START.includes(role) ? 'and start' : 'but not start'}`, async () => {
        const incidentId = await newIncident();
        const res = await start(actors[role], incidentId);
        expect(res.status).toBe(MAY_START.includes(role) ? 202 : 403);
        expect((await list(actors[role], incidentId)).status).toBe(200);
      });
    }
  });

  describe('starting an investigation', () => {
    it('answers 202 with a queued investigation that has nothing to show yet', async () => {
      const incidentId = await newIncident();
      const res = await start(owner, incidentId, { question: 'Why did this start?' });
      expect(res.status).toBe(202);
      const dto = res.body as InvestigationDto;
      expect(dto).toMatchObject({
        incidentId,
        status: 'QUEUED',
        question: 'Why did this start?',
        requestedByName: 'AI Owner',
        output: null,
        sources: [],
        finishedAt: null,
        error: null,
      });
      expect(dto.providerLabel).toMatch(/no AI model/);
    });

    it('allows only one at a time per incident, and another once it is over', async () => {
      const me = await person();
      const incidentId = await newIncident();
      const first = (await start(me, incidentId)).body as InvestigationDto;
      const second = await start(me, incidentId);
      expect(second.status).toBe(409);
      expect(second.body.error.code).toBe('INVESTIGATION_ACTIVE');
      expect(await t.prisma.aiInvestigation.count({ where: { incidentId } })).toBe(1);

      await t.prisma.aiInvestigation.update({
        where: { id: first.id },
        data: { status: 'FAILED', error: 'x', finishedAt: new Date() },
      });
      expect((await start(me, incidentId)).status).toBe(202);
      const history = (await list(me, incidentId)).body as { data: InvestigationDto[] };
      expect(history.data).toHaveLength(2);
      expect(history.data[0]!.status).toBe('QUEUED'); // newest first
    });

    it('lets two simultaneous requests create only one', async () => {
      const me = await person();
      const incidentId = await newIncident();
      const results = await Promise.all([
        start(me, incidentId),
        start(me, incidentId),
        start(me, incidentId),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([202, 409, 409]);
      expect(await t.prisma.aiInvestigation.count({ where: { incidentId } })).toBe(1);
    });

    it('replaces one that never finished (a worker died) instead of blocking the incident', async () => {
      const me = await person();
      const incidentId = await newIncident();
      const stuck = (await start(me, incidentId)).body as InvestigationDto;
      await t.prisma.aiInvestigation.update({
        where: { id: stuck.id },
        data: { status: 'RUNNING', createdAt: new Date(Date.now() - 11 * 60_000) },
      });
      expect((await start(me, incidentId)).status).toBe(202);
      const old = await t.prisma.aiInvestigation.findUniqueOrThrow({ where: { id: stuck.id } });
      expect(old).toMatchObject({ status: 'FAILED', error: 'timed out before it finished' });
      expect(old.finishedAt).not.toBeNull();
    });

    it('validates the question', async () => {
      const me = await person();
      const incidentId = await newIncident();
      for (const body of [{ question: 'q'.repeat(501) }, { question: 42 }]) {
        const res = await start(me, incidentId, body);
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('VALIDATION_FAILED');
      }
      expect(await t.prisma.aiInvestigation.count({ where: { incidentId } })).toBe(0);
      // A blank question is the same as none.
      const ok = await start(me, incidentId, { question: '   ' });
      expect((ok.body as InvestigationDto).question).toBeNull();
    });

    it('is limited per person', async () => {
      const user = await userWithRole(t, orgId, 'DEVELOPER');
      let last = 0;
      for (let i = 0; i < 11; i += 1) {
        last = (await start(user, await newIncident())).status;
      }
      expect(last).toBe(429);
    }, 60_000);

    it('records who started it in the audit log, without the question text', async () => {
      const auditor = await registerUser(t, 'AI Owner');
      const org = await createOrg(auditor, 'AI Audit Org');
      const incidentId = await newIncident(org.id, auditor);
      const started = (await start(auditor, incidentId, { question: 'a private question' }, org.id))
        .body as InvestigationDto;
      const log = (await auditor.client.get(`/orgs/${org.id}/audit-logs?limit=50`))
        .body as AuditLogPageDto;
      const entry = log.data.find((e) => e.action === 'ai.investigation.requested')!;
      expect(entry).toMatchObject({
        actorLabel: 'AI Owner',
        resourceType: 'incident',
        resourceId: incidentId,
      });
      expect(entry.metadata).toMatchObject({ investigationId: started.id, hasQuestion: true });
      expect(JSON.stringify(entry)).not.toContain('a private question');
    });
  });

  describe('reading investigations', () => {
    it('returns a finished investigation with its answer and the sources it read', async () => {
      const incidentId = await newIncident();
      const context = [
        {
          label: 'INC-EVT-1',
          kind: 'incident_event',
          title: 'Timeline',
          text: 'Ada opened this incident',
          occurredAt: null,
          refId: null,
          facts: {},
        },
      ];
      await t.prisma.aiInvestigation.create({
        data: {
          organizationId: orgId,
          incidentId,
          requestedById: owner.id,
          status: 'SUCCEEDED',
          providerId: 'rules-v1',
          providerLabel: 'Rules',
          context,
          output: OUTPUT as object,
          droppedCitations: 2,
          truncated: true,
          finishedAt: new Date(),
        },
      });
      const dto = ((await list(owner, incidentId)).body as { data: InvestigationDto[] }).data[0]!;
      expect(dto).toMatchObject({ status: 'SUCCEEDED', droppedCitations: 2, truncated: true });
      expect(dto.output).toEqual(OUTPUT);
      expect(dto.sources[0]).toMatchObject({
        label: 'INC-EVT-1',
        text: 'Ada opened this incident',
      });
    });

    it('does not pass on a stored answer that no longer matches the schema', async () => {
      const incidentId = await newIncident();
      await t.prisma.aiInvestigation.create({
        data: {
          organizationId: orgId,
          incidentId,
          status: 'SUCCEEDED',
          providerId: 'rules-v1',
          providerLabel: 'Rules',
          output: { summary: 'tampered', confidence: 'certain' },
          finishedAt: new Date(),
        },
      });
      const dto = ((await list(owner, incidentId)).body as { data: InvestigationDto[] }).data[0]!;
      expect(dto.output).toBeNull();
    });

    it('lists at most the most recent five', async () => {
      const incidentId = await newIncident();
      for (let i = 0; i < 7; i += 1) {
        await t.prisma.aiInvestigation.create({
          data: {
            organizationId: orgId,
            incidentId,
            status: 'FAILED',
            error: `run ${i}`,
            providerId: 'rules-v1',
            providerLabel: 'Rules',
            finishedAt: new Date(),
            createdAt: new Date(Date.now() - (10 - i) * 60_000),
          },
        });
      }
      const data = ((await list(owner, incidentId)).body as { data: InvestigationDto[] }).data;
      expect(data).toHaveLength(5);
      expect(data[0]!.error).toBe('run 6');
    });
  });

  describe('tenant isolation', () => {
    it('keeps organizations apart, whatever ids are supplied', async () => {
      const alpha = await registerUser(t, 'Alpha Owner');
      const alphaOrg = (await createOrg(alpha, 'Alpha AI')).id;
      const bravo = await registerUser(t, 'Bravo Owner');
      const bravoOrg = (await createOrg(bravo, 'Bravo AI')).id;
      const bravoIncident = await newIncident(bravoOrg, bravo, 'Bravo secret outage');
      const bravoRun = (await start(bravo, bravoIncident, {}, bravoOrg)).body as InvestigationDto;

      // Alpha cannot use Bravo's organization path...
      expect((await start(alpha, bravoIncident, {}, bravoOrg)).status).toBe(404);
      expect((await list(alpha, bravoIncident, bravoOrg)).status).toBe(404);
      expect((await alpha.client.get(`/orgs/${bravoOrg}/ai/status`)).status).toBe(404);
      // ...nor reach Bravo's incident through its own.
      expect((await start(alpha, bravoIncident, {}, alphaOrg)).status).toBe(404);
      expect((await list(alpha, bravoIncident, alphaOrg)).status).toBe(404);
      expect((await start(alpha, randomUUID(), {}, alphaOrg)).status).toBe(404);
      expect((await start(alpha, 'not-a-uuid', {}, alphaOrg)).status).toBe(404);

      // Nothing was created for Alpha, and Bravo's run is untouched.
      expect(await t.prisma.aiInvestigation.count({ where: { organizationId: alphaOrg } })).toBe(0);
      const still = await t.prisma.aiInvestigation.findUniqueOrThrow({
        where: { id: bravoRun.id },
      });
      expect(still.status).toBe('QUEUED');
    });
  });
});

describe.skipIf(!HAS_INFRA)('AI investigation API, switched off (integration)', () => {
  let t: TestApp;
  let owner: TestUser;
  let orgId: string;

  beforeAll(async () => {
    t = await createTestApp({ env: { AI_PROVIDER: 'none' } });
    owner = await registerUser(t, 'No AI Owner');
    orgId = (await createOrg(owner, 'No AI Org')).id;
  });
  afterAll(() => t.close());

  it('says so, refuses to start one, creates nothing, and still shows history', async () => {
    const status = await owner.client.get(`/orgs/${orgId}/ai/status`);
    expect(status.body as AiStatusDto).toMatchObject({ available: false, kind: 'none' });

    const incident = await createIncident(owner, orgId);
    const res = await owner.client.post(
      `/orgs/${orgId}/incidents/${incident.id}/investigations`,
      {},
    );
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('AI_DISABLED');
    expect(await t.prisma.aiInvestigation.count({ where: { incidentId: incident.id } })).toBe(0);

    const history = await owner.client.get(
      `/orgs/${orgId}/incidents/${incident.id}/investigations`,
    );
    expect(history.status).toBe(200);
    expect(history.body.data).toEqual([]);
  });
});
