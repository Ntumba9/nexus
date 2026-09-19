import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Role } from '@nexus/shared';
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

/**
 * The permission matrix as seen over HTTP. Deliberately spelled out by hand, independent of the
 * shared permission map, so a mistake in either place is caught.
 */
const CAN: Record<string, Role[]> = {
  'organization.read': ROLES,
  'users.read': ROLES,
  'organization.update': ['OWNER', 'ADMIN'],
  'users.manage': ['OWNER', 'ADMIN'],
};

describe.skipIf(!HAS_INFRA)('role-based access control (integration)', () => {
  let t: TestApp;
  let owner: TestUser;
  let org: { id: string };
  const actors = {} as Record<Role, TestUser & { memberId: string }>;

  beforeAll(async () => {
    t = await createTestApp();
    owner = await registerUser(t, 'Founder');
    org = await createOrg(owner, 'RBAC Org');
    for (const role of ROLES) actors[role] = await userWithRole(t, org.id, role);
  });
  afterAll(() => t.close());

  describe.each(ROLES)('%s', (role) => {
    const allowed = (permission: string) => CAN[permission]!.includes(role);

    it('organization.read → GET /orgs/:id', async () => {
      const res = await actors[role].client.get(`/orgs/${org.id}`);
      expect(res.status).toBe(200);
      expect(res.body.role).toBe(role);
    });

    it('users.read → GET /orgs/:id/members', async () => {
      const res = await actors[role].client.get(`/orgs/${org.id}/members`);
      expect(res.status).toBe(200);
      expect(res.body.data.length).toBeGreaterThanOrEqual(ROLES.length);
    });

    it('organization.update → PATCH /orgs/:id', async () => {
      const res = await actors[role].client.patch(`/orgs/${org.id}`, {
        name: `Renamed by ${role}`,
      });
      if (allowed('organization.update')) {
        expect(res.status).toBe(200);
        expect(res.body.name).toBe(`Renamed by ${role}`);
      } else {
        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe('FORBIDDEN');
      }
    });

    it('users.manage → POST /orgs/:id/members', async () => {
      const newcomer = await registerUser(t, 'Newcomer');
      const res = await actors[role].client.post(`/orgs/${org.id}/members`, {
        email: newcomer.email,
        role: 'VIEWER',
      });
      expect(res.status).toBe(allowed('users.manage') ? 201 : 403);
      const stored = await t.prisma.organizationMember.count({ where: { userId: newcomer.id } });
      expect(stored).toBe(allowed('users.manage') ? 1 : 0);
    });

    it('users.manage → PATCH and DELETE /orgs/:id/members/:memberId', async () => {
      const victim = await userWithRole(t, org.id, 'VIEWER');
      const patch = await actors[role].client.patch(`/orgs/${org.id}/members/${victim.memberId}`, {
        role: 'SUPPORT',
      });
      expect(patch.status).toBe(allowed('users.manage') ? 200 : 403);
      const del = await actors[role].client.delete(`/orgs/${org.id}/members/${victim.memberId}`);
      expect(del.status).toBe(allowed('users.manage') ? 204 : 403);
      const remaining = await t.prisma.organizationMember.count({ where: { id: victim.memberId } });
      expect(remaining).toBe(allowed('users.manage') ? 0 : 1);
    });
  });

  it('forbidden responses do not reveal what the caller is missing beyond FORBIDDEN', async () => {
    const res = await actors.VIEWER.client.patch(`/orgs/${org.id}`, { name: 'x' });
    expect(res.body.error).toMatchObject({ code: 'FORBIDDEN' });
    expect(JSON.stringify(res.body)).not.toMatch(/organization\.update|VIEWER|permission map/);
  });

  describe('ownership rules', () => {
    it('an ADMIN cannot grant the OWNER role, or modify/remove an OWNER', async () => {
      const admin = actors.ADMIN.client;
      const grantOnAdd = await admin.post(`/orgs/${org.id}/members`, {
        email: (await registerUser(t)).email,
        role: 'OWNER',
      });
      expect(grantOnAdd.status).toBe(403);
      expect(grantOnAdd.body.error.code).toBe('OWNER_ONLY');

      const promoteSelf = await admin.patch(`/orgs/${org.id}/members/${actors.ADMIN.memberId}`, {
        role: 'OWNER',
      });
      expect(promoteSelf.status).toBe(403);

      const ownerMember = actors.OWNER.memberId;
      expect(
        (await admin.patch(`/orgs/${org.id}/members/${ownerMember}`, { role: 'VIEWER' })).status,
      ).toBe(403);
      expect((await admin.delete(`/orgs/${org.id}/members/${ownerMember}`)).status).toBe(403);
      expect(
        await t.prisma.organizationMember.findUniqueOrThrow({ where: { id: ownerMember } }),
      ).toMatchObject({ role: 'OWNER' });
    });

    it('an OWNER can promote to OWNER, and demote or remove another OWNER while one remains', async () => {
      const second = await userWithRole(t, org.id, 'ADMIN');
      const promote = await actors.OWNER.client.patch(
        `/orgs/${org.id}/members/${second.memberId}`,
        { role: 'OWNER' },
      );
      expect(promote.status).toBe(200);
      expect(promote.body.role).toBe('OWNER');
      const demote = await actors.OWNER.client.patch(`/orgs/${org.id}/members/${second.memberId}`, {
        role: 'ADMIN',
      });
      expect(demote.status).toBe(200);
      expect(
        (await actors.OWNER.client.delete(`/orgs/${org.id}/members/${second.memberId}`)).status,
      ).toBe(204);
    });

    it('the last OWNER can neither be demoted nor removed', async () => {
      const solo = await registerUser(t, 'Solo');
      const soloOrg = await createOrg(solo, 'Solo Org');
      const me = (await solo.client.get(`/orgs/${soloOrg.id}/members`)).body.data[0];
      const demote = await solo.client.patch(`/orgs/${soloOrg.id}/members/${me.id}`, {
        role: 'ADMIN',
      });
      const remove = await solo.client.delete(`/orgs/${soloOrg.id}/members/${me.id}`);
      expect(demote.status).toBe(409);
      expect(demote.body.error.code).toBe('LAST_OWNER');
      expect(remove.status).toBe(409);
      expect(
        await t.prisma.organizationMember.count({
          where: { organizationId: soloOrg.id, role: 'OWNER' },
        }),
      ).toBe(1);
    });

    it('concurrent demotions cannot leave an organisation without an owner', async () => {
      const a = await registerUser(t, 'Co-owner A');
      const orgX = await createOrg(a, 'Race Org');
      const b = await userWithRole(t, orgX.id, 'OWNER');
      const aMember = (await a.client.get(`/orgs/${orgX.id}/members`)).body.data.find(
        (m: { userId: string }) => m.userId === a.id,
      );

      const results = await Promise.all([
        a.client.patch(`/orgs/${orgX.id}/members/${b.memberId}`, { role: 'VIEWER' }),
        b.client.patch(`/orgs/${orgX.id}/members/${aMember.id}`, { role: 'VIEWER' }),
      ]);
      // Exactly one demotion wins. The loser is refused with 409 if both requests were already past
      // the permission guard, or 403 if the winner committed first and the loser is no longer an
      // owner. Which one happens is a matter of timing; the invariant below is what matters.
      const statuses = results.map((r) => r.status).sort();
      expect(statuses[0]).toBe(200);
      expect([403, 409]).toContain(statuses[1]);
      expect(
        await t.prisma.organizationMember.count({
          where: { organizationId: orgX.id, role: 'OWNER' },
        }),
      ).toBe(1);
    });

    it('adding a member: unknown email → 404, duplicate → 409, invalid role → 400', async () => {
      const unknown = await actors.OWNER.client.post(`/orgs/${org.id}/members`, {
        email: `ghost-${randomUUID()}@example.com`,
        role: 'VIEWER',
      });
      expect(unknown.status).toBe(404);
      const dup = await actors.OWNER.client.post(`/orgs/${org.id}/members`, {
        email: actors.VIEWER.email,
        role: 'VIEWER',
      });
      expect(dup.status).toBe(409);
      expect(dup.body.error.code).toBe('ALREADY_MEMBER');
      const bad = await actors.OWNER.client.post(`/orgs/${org.id}/members`, {
        email: actors.VIEWER.email,
        role: 'GOD',
      });
      expect(bad.status).toBe(400);
    });
  });

  describe('organisation creation and settings', () => {
    it('creates an organisation with the caller as its only OWNER and a generated slug', async () => {
      const user = await registerUser(t);
      const res = await user.client.post('/orgs', { name: 'Ünïcode & Friends!' });
      expect(res.status).toBe(201);
      expect(res.body.role).toBe('OWNER');
      expect(res.body.slug).toMatch(/^unicode-friends-[0-9a-f]{6}$/);
      const members = await t.prisma.organizationMember.findMany({
        where: { organizationId: res.body.id },
      });
      expect(members).toHaveLength(1);
      expect(members[0]).toMatchObject({ userId: user.id, role: 'OWNER' });
    });

    it('validates names', async () => {
      const user = await registerUser(t);
      expect((await user.client.post('/orgs', { name: '' })).status).toBe(400);
      expect((await user.client.post('/orgs', { name: 'x'.repeat(101) })).status).toBe(400);
      expect((await user.client.post('/orgs', {})).status).toBe(400);
    });

    it('the same name can be used by different organisations (slugs stay unique)', async () => {
      const a = await createOrg(await registerUser(t), 'Same Name');
      const b = await createOrg(await registerUser(t), 'Same Name');
      expect(a.id).not.toBe(b.id);
      const slugs = await t.prisma.organization.findMany({
        where: { id: { in: [a.id, b.id] } },
        select: { slug: true },
      });
      expect(new Set(slugs.map((s) => s.slug)).size).toBe(2);
    });
  });
});
