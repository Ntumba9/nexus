import { randomUUID } from 'node:crypto';
import type { Role } from '@nexus/shared';
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

const ROLES: Role[] = ['OWNER', 'ADMIN', 'DEVELOPER', 'SUPPORT', 'VIEWER'];
/** Hand-written, independent of the shared permission map. */
const CAN_MANAGE_CATALOG: Role[] = ['OWNER', 'ADMIN', 'DEVELOPER'];
const CAN_CREATE_INCIDENTS: Role[] = ['OWNER', 'ADMIN', 'DEVELOPER', 'SUPPORT'];
const CAN_RESOLVE: Role[] = ['OWNER', 'ADMIN', 'DEVELOPER'];

describe.skipIf(!HAS_INFRA)(
  'projects, services and the Phase 3 permission matrix (integration)',
  () => {
    let t: TestApp;
    let owner: TestUser;
    let orgId: string;
    const actors = {} as Record<Role, TestUser & { memberId: string }>;

    beforeAll(async () => {
      t = await createTestApp();
      owner = await registerUser(t, 'Owner');
      orgId = (await createOrg(owner, 'Catalog Org')).id;
      for (const role of ROLES) actors[role] = await userWithRole(t, orgId, role);
    });
    afterAll(() => t.close());

    describe('projects', () => {
      it('creates, reads, lists, updates and archives a project', async () => {
        const created = await owner.client.post(`/orgs/${orgId}/projects`, {
          name: 'Customer Portal',
          description: 'Web app',
        });
        expect(created.status).toBe(201);
        expect(created.body).toMatchObject({
          name: 'Customer Portal',
          description: 'Web app',
          serviceCount: 0,
          archivedAt: null,
        });
        expect(created.body.slug).toMatch(/^customer-portal-[0-9a-f]{6}$/);
        const id = created.body.id as string;

        expect((await owner.client.get(`/orgs/${orgId}/projects/${id}`)).body.name).toBe(
          'Customer Portal',
        );
        const patched = await owner.client.patch(`/orgs/${orgId}/projects/${id}`, {
          description: 'Updated',
        });
        expect(patched.body).toMatchObject({ name: 'Customer Portal', description: 'Updated' });
        expect((await owner.client.patch(`/orgs/${orgId}/projects/${id}`, {})).status).toBe(400);

        expect(
          (await owner.client.get(`/orgs/${orgId}/projects`)).body.data.map(
            (p: { id: string }) => p.id,
          ),
        ).toContain(id);
        expect((await owner.client.delete(`/orgs/${orgId}/projects/${id}`)).status).toBe(204);
        expect((await owner.client.delete(`/orgs/${orgId}/projects/${id}`)).status).toBe(204); // idempotent

        const active = (await owner.client.get(`/orgs/${orgId}/projects`)).body.data.map(
          (p: { id: string }) => p.id,
        );
        expect(active).not.toContain(id);
        const all = (await owner.client.get(`/orgs/${orgId}/projects?includeArchived=true`)).body
          .data;
        expect(all.find((p: { id: string }) => p.id === id).archivedAt).not.toBeNull();
      });

      it('validates names and gives same-named projects distinct slugs', async () => {
        expect((await owner.client.post(`/orgs/${orgId}/projects`, { name: '' })).status).toBe(400);
        expect(
          (await owner.client.post(`/orgs/${orgId}/projects`, { name: 'x'.repeat(101) })).status,
        ).toBe(400);
        const a = await createProject(owner, orgId, 'Twin');
        const b = await createProject(owner, orgId, 'Twin');
        expect(a.slug).not.toBe(b.slug);
      });

      it('archiving a project archives its services but keeps incident history intact', async () => {
        const project = await createProject(owner, orgId, 'Legacy');
        const service = await createService(owner, orgId, project.id, 'Old API');
        const incident = await createIncident(owner, orgId, { serviceId: service.id });

        await owner.client.delete(`/orgs/${orgId}/projects/${project.id}`);
        expect(
          (await owner.client.get(`/orgs/${orgId}/services/${service.id}`)).body.archivedAt,
        ).not.toBeNull();
        const kept = await owner.client.get(`/orgs/${orgId}/incidents/${incident.id}`);
        expect(kept.status).toBe(200);
        expect(kept.body.service).toMatchObject({ id: service.id });

        const blocked = await owner.client.post(`/orgs/${orgId}/projects/${project.id}/services`, {
          name: 'New',
        });
        expect(blocked.status).toBe(409);
        expect(blocked.body.error.code).toBe('PROJECT_ARCHIVED');
      });
    });

    describe('services', () => {
      it('creates services with an environment, lists per project and org-wide', async () => {
        const project = await createProject(owner, orgId, 'Platform');
        const api = await createService(owner, orgId, project.id, 'API', 'PRODUCTION');
        const staging = await createService(owner, orgId, project.id, 'API', 'STAGING');
        expect(api).toMatchObject({
          name: 'API',
          environment: 'PRODUCTION',
          healthStatus: 'UNKNOWN',
          projectName: 'Platform',
        });
        expect(staging.environment).toBe('STAGING');

        const inProject = (
          await owner.client.get(`/orgs/${orgId}/services?projectId=${project.id}`)
        ).body.data;
        expect(inProject.map((s: { id: string }) => s.id).sort()).toEqual(
          [api.id, staging.id].sort(),
        );
        expect(
          (await owner.client.get(`/orgs/${orgId}/projects/${project.id}`)).body.serviceCount,
        ).toBe(2);
      });

      it('rejects duplicate name+environment within a project (409) but allows it across environments', async () => {
        const project = await createProject(owner, orgId, 'Dupes');
        await createService(owner, orgId, project.id, 'Database', 'PRODUCTION');
        const dup = await owner.client.post(`/orgs/${orgId}/projects/${project.id}/services`, {
          name: 'Database',
          environment: 'PRODUCTION',
        });
        expect(dup.status).toBe(409);
        expect(dup.body.error.code).toBe('SERVICE_EXISTS');
        expect(
          (
            await owner.client.post(`/orgs/${orgId}/projects/${project.id}/services`, {
              name: 'Database',
              environment: 'STAGING',
            })
          ).status,
        ).toBe(201);
      });

      it('updates and archives services, validating input', async () => {
        const project = await createProject(owner, orgId, 'Edits');
        const service = await createService(owner, orgId, project.id, 'Email');
        const updated = await owner.client.patch(`/orgs/${orgId}/services/${service.id}`, {
          name: 'Email Delivery',
          environment: 'STAGING',
        });
        expect(updated.body).toMatchObject({ name: 'Email Delivery', environment: 'STAGING' });
        expect(
          (
            await owner.client.patch(`/orgs/${orgId}/services/${service.id}`, {
              environment: 'MOON',
            })
          ).status,
        ).toBe(400);
        expect((await owner.client.delete(`/orgs/${orgId}/services/${service.id}`)).status).toBe(
          204,
        );
        expect(
          (await owner.client.get(`/orgs/${orgId}/services`)).body.data.map(
            (s: { id: string }) => s.id,
          ),
        ).not.toContain(service.id);
      });

      it('404s for unknown ids and unknown parent projects', async () => {
        expect((await owner.client.get(`/orgs/${orgId}/services/${randomUUID()}`)).status).toBe(
          404,
        );
        expect(
          (
            await owner.client.post(`/orgs/${orgId}/projects/${randomUUID()}/services`, {
              name: 'X',
            })
          ).status,
        ).toBe(404);
        expect((await owner.client.get(`/orgs/${orgId}/projects/not-a-uuid`)).status).toBe(404);
      });
    });

    describe.each(ROLES)('%s: permission matrix over HTTP', (role) => {
      const actor = () => actors[role];

      it('reads projects, services, incidents and the dashboard (every role)', async () => {
        const project = await createProject(owner, orgId, `Read ${role}`);
        for (const path of [
          '/projects',
          `/projects/${project.id}`,
          '/services',
          '/incidents',
          '/dashboard',
        ]) {
          expect((await actor().client.get(`/orgs/${orgId}${path}`)).status, path).toBe(200);
        }
      });

      it('projects.manage: create, update, archive projects', async () => {
        const allowed = CAN_MANAGE_CATALOG.includes(role);
        const victim = await createProject(owner, orgId, `Target ${role}`);
        const create = await actor().client.post(`/orgs/${orgId}/projects`, { name: `By ${role}` });
        const patch = await actor().client.patch(`/orgs/${orgId}/projects/${victim.id}`, {
          description: role,
        });
        const archive = await actor().client.delete(`/orgs/${orgId}/projects/${victim.id}`);
        expect([create.status, patch.status, archive.status]).toEqual(
          allowed ? [201, 200, 204] : [403, 403, 403],
        );
        if (!allowed) {
          const after = await owner.client.get(`/orgs/${orgId}/projects/${victim.id}`);
          expect(after.body).toMatchObject({ description: 'Test project', archivedAt: null });
        }
      });

      it('services.manage: create, update, archive services', async () => {
        const allowed = CAN_MANAGE_CATALOG.includes(role);
        const project = await createProject(owner, orgId, `Svc ${role}`);
        const service = await createService(owner, orgId, project.id, 'Existing');
        const create = await actor().client.post(`/orgs/${orgId}/projects/${project.id}/services`, {
          name: `New ${role}`,
        });
        const patch = await actor().client.patch(`/orgs/${orgId}/services/${service.id}`, {
          description: role,
        });
        const archive = await actor().client.delete(`/orgs/${orgId}/services/${service.id}`);
        expect([create.status, patch.status, archive.status]).toEqual(
          allowed ? [201, 200, 204] : [403, 403, 403],
        );
      });

      it('incidents.create / incidents.update: create, edit, comment, assign, acknowledge', async () => {
        const allowed = CAN_CREATE_INCIDENTS.includes(role);
        const existing = await createIncident(owner, orgId);
        const base = `/orgs/${orgId}/incidents`;
        const create = await actor().client.post(base, { title: `By ${role}`, severity: 'SEV3' });
        const edit = await actor().client.patch(`${base}/${existing.id}`, {
          title: `Edited by ${role}`,
        });
        const comment = await actor().client.post(`${base}/${existing.id}/comments`, {
          body: `Hi from ${role}`,
        });
        const assign = await actor().client.send('put', `${base}/${existing.id}/assignees`, {
          body: { userIds: [] },
        });
        const ack = await actor().client.post(`${base}/${existing.id}/transitions`, {
          to: 'ACKNOWLEDGED',
        });
        expect([create.status, edit.status, comment.status, assign.status, ack.status]).toEqual(
          allowed ? [201, 200, 201, 200, 200] : [403, 403, 403, 403, 403],
        );
      });

      it('incidents.resolve: resolve and reopen', async () => {
        const allowed = CAN_RESOLVE.includes(role);
        const incident = await createIncident(owner, orgId);
        await owner.client.post(`/orgs/${orgId}/incidents/${incident.id}/transitions`, {
          to: 'ACKNOWLEDGED',
        });
        const resolve = await actor().client.post(
          `/orgs/${orgId}/incidents/${incident.id}/transitions`,
          { to: 'RESOLVED' },
        );
        // SUPPORT and VIEWER never resolve; VIEWER cannot even acknowledge.
        expect(resolve.status).toBe(allowed ? 200 : 403);
        if (!allowed) {
          expect(
            (await owner.client.get(`/orgs/${orgId}/incidents/${incident.id}`)).body.status,
          ).toBe('ACKNOWLEDGED');
        } else {
          const reopen = await actor().client.post(
            `/orgs/${orgId}/incidents/${incident.id}/transitions`,
            { to: 'INVESTIGATING' },
          );
          expect(reopen.status).toBe(200);
        }
      });
    });
  },
);
