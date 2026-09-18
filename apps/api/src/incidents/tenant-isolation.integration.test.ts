import { randomUUID } from 'node:crypto';
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

interface Tenant {
  user: TestUser;
  orgId: string;
  projectId: string;
  serviceId: string;
  incidentId: string;
  incidentNumber: number;
}

describe.skipIf(!HAS_INFRA)(
  'tenant isolation for projects, services and incidents (integration)',
  () => {
    let t: TestApp;
    let a: Tenant;
    let b: Tenant;

    async function makeTenant(label: string): Promise<Tenant> {
      const user = await registerUser(t, `${label} Owner`);
      const org = await createOrg(user, `${label} Org`);
      const project = await createProject(user, org.id, `${label} Project`);
      const service = await createService(user, org.id, project.id, `${label} Service`);
      const incident = await createIncident(user, org.id, {
        title: `${label} secret incident`,
        serviceId: service.id,
        severity: 'SEV1',
      });
      return {
        user,
        orgId: org.id,
        projectId: project.id,
        serviceId: service.id,
        incidentId: incident.id,
        incidentNumber: incident.number,
      };
    }

    beforeAll(async () => {
      t = await createTestApp();
      a = await makeTenant('Alpha');
      b = await makeTenant('Bravo');
    });
    afterAll(() => t.close());

    describe('over HTTP', () => {
      it("Alpha cannot see or change Bravo's data by using Bravo's org id (non-member → 404)", async () => {
        for (const path of [
          '/projects',
          '/services',
          '/incidents',
          '/dashboard',
          `/incidents/${b.incidentId}`,
          `/incidents/${b.incidentId}/events`,
          `/projects/${b.projectId}`,
        ]) {
          const res = await a.user.client.get(`/orgs/${b.orgId}${path}`);
          expect(res.status, path).toBe(404);
          expect(JSON.stringify(res.body)).not.toContain('Bravo');
        }
        const writes = await Promise.all([
          a.user.client.post(`/orgs/${b.orgId}/projects`, { name: 'Injected' }),
          a.user.client.post(`/orgs/${b.orgId}/incidents`, { title: 'Injected', severity: 'SEV1' }),
          a.user.client.post(`/orgs/${b.orgId}/incidents/${b.incidentId}/transitions`, {
            to: 'CANCELLED',
          }),
          a.user.client.post(`/orgs/${b.orgId}/incidents/${b.incidentId}/comments`, {
            body: 'Injected',
          }),
        ]);
        for (const res of writes) expect(res.status).toBe(404);
      });

      it("Alpha cannot reach Bravo's project, service or incident by using its id inside Alpha's OWN org path", async () => {
        const base = `/orgs/${a.orgId}`;
        const attempts = [
          ['get', `${base}/projects/${b.projectId}`],
          ['get', `${base}/services/${b.serviceId}`],
          ['get', `${base}/incidents/${b.incidentId}`],
          ['get', `${base}/incidents/${b.incidentId}/events`],
        ] as const;
        for (const [method, path] of attempts) {
          const res = await a.user.client.send(method, path);
          expect(res.status, path).toBe(404);
          expect(JSON.stringify(res.body)).not.toContain('Bravo');
        }

        const mutations = await Promise.all([
          a.user.client.patch(`${base}/projects/${b.projectId}`, { name: 'Hijacked' }),
          a.user.client.delete(`${base}/projects/${b.projectId}`),
          a.user.client.patch(`${base}/services/${b.serviceId}`, { name: 'Hijacked' }),
          a.user.client.delete(`${base}/services/${b.serviceId}`),
          a.user.client.post(`${base}/projects/${b.projectId}/services`, { name: 'Injected' }),
          a.user.client.patch(`${base}/incidents/${b.incidentId}`, {
            title: 'Hijacked',
            severity: 'SEV4',
          }),
          a.user.client.post(`${base}/incidents/${b.incidentId}/transitions`, { to: 'CANCELLED' }),
          a.user.client.post(`${base}/incidents/${b.incidentId}/comments`, { body: 'Injected' }),
          a.user.client.send('put', `${base}/incidents/${b.incidentId}/assignees`, {
            body: { userIds: [a.user.id] },
          }),
        ]);
        for (const res of mutations) expect(res.status).toBe(404);

        // Bravo's data is byte-for-byte untouched.
        const project = await t.prisma.project.findUniqueOrThrow({ where: { id: b.projectId } });
        const service = await t.prisma.service.findUniqueOrThrow({ where: { id: b.serviceId } });
        const incident = await t.prisma.incident.findUniqueOrThrow({ where: { id: b.incidentId } });
        expect(project).toMatchObject({ name: 'Bravo Project', archivedAt: null });
        expect(service).toMatchObject({ name: 'Bravo Service', archivedAt: null });
        expect(incident).toMatchObject({
          title: 'Bravo secret incident',
          severity: 'SEV1',
          status: 'OPEN',
        });
        expect(await t.prisma.incidentEvent.count({ where: { incidentId: b.incidentId } })).toBe(1);
        expect(await t.prisma.incidentComment.count({ where: { incidentId: b.incidentId } })).toBe(
          0,
        );
        expect(
          await t.prisma.incidentAssignment.count({ where: { incidentId: b.incidentId } }),
        ).toBe(0);
      });

      it('foreign ids get exactly the same 404 as ids that never existed', async () => {
        const paths = (ids: { project: string; service: string; incident: string }) => [
          `/orgs/${a.orgId}/projects/${ids.project}`,
          `/orgs/${a.orgId}/services/${ids.service}`,
          `/orgs/${a.orgId}/incidents/${ids.incident}`,
        ];
        const foreign = paths({
          project: b.projectId,
          service: b.serviceId,
          incident: b.incidentId,
        });
        const missing = paths({
          project: randomUUID(),
          service: randomUUID(),
          incident: randomUUID(),
        });
        for (let i = 0; i < foreign.length; i++) {
          const f = await a.user.client.get(foreign[i]!);
          const m = await a.user.client.get(missing[i]!);
          expect(f.status).toBe(404);
          expect(f.body.error.code).toBe(m.body.error.code);
          expect(f.body.error.message).toBe(m.body.error.message);
        }
      });

      it("cannot create an incident against another organisation's service, and nothing is created or numbered", async () => {
        const before = await t.prisma.organization.findUniqueOrThrow({
          where: { id: a.orgId },
          select: { incidentCounter: true },
        });
        const incidentsBefore = await t.prisma.incident.count({
          where: { organizationId: a.orgId },
        });

        const res = await a.user.client.post(`/orgs/${a.orgId}/incidents`, {
          title: 'Sneaky',
          severity: 'SEV2',
          serviceId: b.serviceId,
        });
        expect(res.status).toBe(404);

        expect(await t.prisma.incident.count({ where: { organizationId: a.orgId } })).toBe(
          incidentsBefore,
        );
        expect(
          await t.prisma.incident.count({
            where: { serviceId: b.serviceId, organizationId: a.orgId },
          }),
        ).toBe(0);
        const after = await t.prisma.organization.findUniqueOrThrow({
          where: { id: a.orgId },
          select: { incidentCounter: true },
        });
        expect(after.incidentCounter).toBe(before.incidentCounter); // the failed attempt did not burn a number
      });

      it("cannot assign another organisation's user, even one who is a member elsewhere", async () => {
        const res = await a.user.client.send(
          'put',
          `/orgs/${a.orgId}/incidents/${a.incidentId}/assignees`,
          { body: { userIds: [b.user.id] } },
        );
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('ASSIGNEE_NOT_MEMBER');
      });

      it('listings and the dashboard only ever contain the caller organisation’s data', async () => {
        const incidents = (await a.user.client.get(`/orgs/${a.orgId}/incidents`)).body.data;
        expect(incidents.map((i: { title: string }) => i.title)).toEqual(['Alpha secret incident']);
        expect(
          (await a.user.client.get(`/orgs/${a.orgId}/projects`)).body.data.map(
            (p: { name: string }) => p.name,
          ),
        ).toEqual(['Alpha Project']);
        expect(
          (await a.user.client.get(`/orgs/${a.orgId}/services`)).body.data.map(
            (s: { name: string }) => s.name,
          ),
        ).toEqual(['Alpha Service']);

        const dashboard = (await a.user.client.get(`/orgs/${a.orgId}/dashboard`)).body;
        expect(JSON.stringify(dashboard)).not.toContain('Bravo');
        expect(dashboard.activeIncidents.total).toBe(1);
        expect(dashboard.serviceHealth.total).toBe(1);
      });

      it('filters cannot be used to cross the boundary (serviceId of another org just matches nothing)', async () => {
        const res = await a.user.client.get(`/orgs/${a.orgId}/incidents?serviceId=${b.serviceId}`);
        expect(res.status).toBe(200);
        expect(res.body.data).toEqual([]);
      });

      it('incident numbers are independent per organisation', async () => {
        expect(a.incidentNumber).toBe(1);
        expect(b.incidentNumber).toBe(1);
      });
    });

    describe('enforced by the database itself (raw SQL, bypassing the application)', () => {
      const rejects = (promise: Promise<unknown>, pattern: RegExp) =>
        expect(promise).rejects.toThrow(pattern);

      it('composite foreign keys make a cross-tenant reference impossible: Incident → Service', async () => {
        await rejects(
          t.prisma
            .$executeRaw`INSERT INTO "Incident" ("organizationId", "number", "serviceId", "title", "severity", "updatedAt")
          VALUES (${a.orgId}::uuid, 9001, ${b.serviceId}::uuid, 'Cross-tenant', 'SEV3', now())`,
          /foreign key/i,
        );
      });

      it('…Service → Project', async () => {
        await rejects(
          t.prisma
            .$executeRaw`INSERT INTO "Service" ("organizationId", "projectId", "name", "updatedAt")
          VALUES (${a.orgId}::uuid, ${b.projectId}::uuid, 'Cross-tenant', now())`,
          /foreign key/i,
        );
      });

      it('…IncidentEvent, IncidentComment, IncidentTag and IncidentAssignment → Incident', async () => {
        await rejects(
          t.prisma
            .$executeRaw`INSERT INTO "IncidentEvent" ("organizationId", "incidentId", "type", "actorType")
          VALUES (${a.orgId}::uuid, ${b.incidentId}::uuid, 'UPDATED', 'SYSTEM')`,
          /foreign key/i,
        );
        await rejects(
          t.prisma
            .$executeRaw`INSERT INTO "IncidentComment" ("organizationId", "incidentId", "authorId", "body")
          VALUES (${a.orgId}::uuid, ${b.incidentId}::uuid, ${a.user.id}::uuid, 'x')`,
          /foreign key/i,
        );
        await rejects(
          t.prisma.$executeRaw`INSERT INTO "IncidentTag" ("organizationId", "incidentId", "tag")
          VALUES (${a.orgId}::uuid, ${b.incidentId}::uuid, 'x')`,
          /foreign key/i,
        );
        await rejects(
          t.prisma
            .$executeRaw`INSERT INTO "IncidentAssignment" ("organizationId", "incidentId", "userId", "assignedById")
          VALUES (${a.orgId}::uuid, ${b.incidentId}::uuid, ${a.user.id}::uuid, ${a.user.id}::uuid)`,
          /foreign key/i,
        );
      });

      it('the same references are accepted when the organisation matches (the check is not simply always failing)', async () => {
        await expect(
          t.prisma.$executeRaw`INSERT INTO "IncidentTag" ("organizationId", "incidentId", "tag")
          VALUES (${a.orgId}::uuid, ${a.incidentId}::uuid, 'db-direct')`,
        ).resolves.toBe(1);
      });

      it('the incident timeline is append-only: UPDATE, DELETE and TRUNCATE are refused', async () => {
        await rejects(
          t.prisma
            .$executeRaw`UPDATE "IncidentEvent" SET "type" = 'UPDATED' WHERE "incidentId" = ${a.incidentId}::uuid`,
          /append-only/i,
        );
        await rejects(
          t.prisma
            .$executeRaw`DELETE FROM "IncidentEvent" WHERE "incidentId" = ${a.incidentId}::uuid`,
          /append-only/i,
        );
        await rejects(t.prisma.$executeRawUnsafe('TRUNCATE TABLE "IncidentEvent"'), /append-only/i);
        expect(
          await t.prisma.incidentEvent.count({ where: { incidentId: a.incidentId } }),
        ).toBeGreaterThan(0);
      });

      it('status and timestamps cannot disagree', async () => {
        await rejects(
          t.prisma
            .$executeRaw`UPDATE "Incident" SET "status" = 'RESOLVED' WHERE "id" = ${a.incidentId}::uuid`,
          /Incident_resolved_consistency_check/,
        );
        await rejects(
          t.prisma
            .$executeRaw`UPDATE "Incident" SET "resolvedAt" = now() WHERE "id" = ${a.incidentId}::uuid`,
          /Incident_resolved_consistency_check/,
        );
        await rejects(
          t.prisma
            .$executeRaw`UPDATE "Incident" SET "status" = 'CANCELLED' WHERE "id" = ${a.incidentId}::uuid`,
          /Incident_cancelled_consistency_check/,
        );
      });

      it('rejects out-of-range and malformed values, and duplicate identifiers', async () => {
        await rejects(
          t.prisma
            .$executeRaw`UPDATE "Incident" SET "title" = '' WHERE "id" = ${a.incidentId}::uuid`,
          /Incident_title_length_check/,
        );
        await rejects(
          t.prisma
            .$executeRaw`UPDATE "Incident" SET "number" = 0 WHERE "id" = ${a.incidentId}::uuid`,
          /Incident_number_positive_check/,
        );
        await rejects(
          t.prisma
            .$executeRaw`INSERT INTO "IncidentTag" ("organizationId", "incidentId", "tag") VALUES (${a.orgId}::uuid, ${a.incidentId}::uuid, 'Bad Tag')`,
          /IncidentTag_format_check/,
        );
        await rejects(
          t.prisma
            .$executeRaw`INSERT INTO "IncidentComment" ("organizationId", "incidentId", "authorId", "body") VALUES (${a.orgId}::uuid, ${a.incidentId}::uuid, ${a.user.id}::uuid, '')`,
          /IncidentComment_body_length_check/,
        );
        await rejects(
          t.prisma
            .$executeRaw`UPDATE "Project" SET "slug" = 'Not Valid!' WHERE "id" = ${a.projectId}::uuid`,
          /Project_slug_format_check/,
        );
        // Same number twice in one organisation.
        await rejects(
          t.prisma
            .$executeRaw`INSERT INTO "Incident" ("organizationId", "number", "title", "severity", "updatedAt") VALUES (${a.orgId}::uuid, ${a.incidentNumber}, 'dup', 'SEV3', now())`,
          /23505/, // PostgreSQL unique_violation
        );
      });

      it('allows at most one ACTIVE assignment per user per incident, but keeps history', async () => {
        const first = await t.prisma
          .$executeRaw`INSERT INTO "IncidentAssignment" ("organizationId", "incidentId", "userId", "assignedById")
        VALUES (${a.orgId}::uuid, ${a.incidentId}::uuid, ${a.user.id}::uuid, ${a.user.id}::uuid)`;
        expect(first).toBe(1);
        await rejects(
          t.prisma
            .$executeRaw`INSERT INTO "IncidentAssignment" ("organizationId", "incidentId", "userId", "assignedById")
          VALUES (${a.orgId}::uuid, ${a.incidentId}::uuid, ${a.user.id}::uuid, ${a.user.id}::uuid)`,
          /23505/, // the partial unique index: one ACTIVE assignment per user per incident
        );
        await t.prisma
          .$executeRaw`UPDATE "IncidentAssignment" SET "unassignedAt" = now() WHERE "incidentId" = ${a.incidentId}::uuid AND "userId" = ${a.user.id}::uuid`;
        await expect(
          t.prisma
            .$executeRaw`INSERT INTO "IncidentAssignment" ("organizationId", "incidentId", "userId", "assignedById")
          VALUES (${a.orgId}::uuid, ${a.incidentId}::uuid, ${a.user.id}::uuid, ${a.user.id}::uuid)`,
        ).resolves.toBe(1);
      });

      it('incidents cannot be deleted while they have history (RESTRICT)', async () => {
        await rejects(
          t.prisma.$executeRaw`DELETE FROM "Incident" WHERE "id" = ${b.incidentId}::uuid`,
          /foreign key|violates|append-only/i,
        );
        expect(await t.prisma.incident.count({ where: { id: b.incidentId } })).toBe(1);
      });
    });
  },
);
