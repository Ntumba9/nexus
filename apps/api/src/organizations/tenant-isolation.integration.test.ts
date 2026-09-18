import { randomUUID } from 'node:crypto';
import { Controller, Get, Param } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  HAS_INFRA,
  addMemberDirect,
  createOrg,
  createTestApp,
  registerUser,
  userWithRole,
  type TestApp,
  type TestUser,
} from '../testing/harness';

/** Deliberately mis-declared routes, to prove the guards deny by default. */
@Controller('rogue')
class RogueController {
  @Get()
  noDeclaration(): string {
    return 'should never be reachable';
  }
}

@Controller('orgs/:orgId/rogue')
class RogueOrgController {
  @Get()
  noPermission(@Param('orgId') orgId: string): string {
    return orgId;
  }
}

describe.skipIf(!HAS_INFRA)('tenant isolation (integration)', () => {
  let t: TestApp;
  let alice: TestUser; // owner of Org A
  let bob: TestUser; // owner of Org B
  let orgA: { id: string; name: string };
  let orgB: { id: string; name: string };
  let bobsColleagueMemberId: string;

  beforeAll(async () => {
    t = await createTestApp({ controllers: [RogueController, RogueOrgController] });
    alice = await registerUser(t, 'Alice');
    bob = await registerUser(t, 'Bob');
    orgA = await createOrg(alice, 'Org A');
    orgB = await createOrg(bob, 'Org B');
    bobsColleagueMemberId = (await userWithRole(t, orgB.id, 'DEVELOPER')).memberId;
  });
  afterAll(() => t.close());

  it('1. a user can read their own organisation', async () => {
    const res = await alice.client.get(`/orgs/${orgA.id}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: orgA.id, name: 'Org A', role: 'OWNER' });
  });

  it("2. a user cannot read another organisation, and the denial looks exactly like 'does not exist'", async () => {
    const foreign = await alice.client.get(`/orgs/${orgB.id}`);
    const missing = await alice.client.get(`/orgs/${randomUUID()}`);
    expect(foreign.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(foreign.body.error.code).toBe(missing.body.error.code);
    expect(foreign.body.error.message).toBe(missing.body.error.message);
    expect(JSON.stringify(foreign.body)).not.toContain('Org B');
  });

  it('2b. every organisation-scoped route is closed to non-members (read, write, list, add, change, remove)', async () => {
    const someMember = bobsColleagueMemberId;
    const attempts = await Promise.all([
      alice.client.get(`/orgs/${orgB.id}/members`),
      alice.client.patch(`/orgs/${orgB.id}`, { name: 'Hijacked' }),
      alice.client.post(`/orgs/${orgB.id}/members`, { email: alice.email, role: 'OWNER' }),
      alice.client.patch(`/orgs/${orgB.id}/members/${someMember}`, { role: 'VIEWER' }),
      alice.client.delete(`/orgs/${orgB.id}/members/${someMember}`),
    ]);
    for (const res of attempts) expect(res.status).toBe(404);

    // Nothing changed.
    const org = await t.prisma.organization.findUniqueOrThrow({ where: { id: orgB.id } });
    expect(org.name).toBe('Org B');
    expect(await t.prisma.organizationMember.count({ where: { organizationId: orgB.id } })).toBe(2);
    expect(
      await t.prisma.organizationMember.findUniqueOrThrow({ where: { id: someMember } }),
    ).toMatchObject({ role: 'DEVELOPER' });
  });

  it("3. a user cannot reach another organisation's resource by using its known id inside their OWN organisation path", async () => {
    // Alice is OWNER of Org A, so she passes the guard for /orgs/A/... — but the member belongs to Org B.
    const patch = await alice.client.patch(`/orgs/${orgA.id}/members/${bobsColleagueMemberId}`, {
      role: 'OWNER',
    });
    const del = await alice.client.delete(`/orgs/${orgA.id}/members/${bobsColleagueMemberId}`);
    expect(patch.status).toBe(404);
    expect(del.status).toBe(404);

    const row = await t.prisma.organizationMember.findUniqueOrThrow({
      where: { id: bobsColleagueMemberId },
    });
    expect(row).toMatchObject({ organizationId: orgB.id, role: 'DEVELOPER' });

    // Same 404 as a member id that never existed.
    const nonexistent = await alice.client.patch(`/orgs/${orgA.id}/members/${randomUUID()}`, {
      role: 'OWNER',
    });
    expect(nonexistent.body.error).toMatchObject({
      code: patch.body.error.code,
      message: patch.body.error.message,
    });
  });

  it('3b. the organisation comes from the URL and the session, never from the request body', async () => {
    const carol = await registerUser(t, 'Carol');
    const res = await alice.client.post(`/orgs/${orgA.id}/members`, {
      email: carol.email,
      role: 'VIEWER',
      organizationId: orgB.id, // attacker-supplied, must be ignored
    });
    expect(res.status).toBe(201);
    const memberships = await t.prisma.organizationMember.findMany({ where: { userId: carol.id } });
    expect(memberships.map((m) => m.organizationId)).toEqual([orgA.id]);
  });

  it('4. GET /orgs lists only the caller’s organisations', async () => {
    const res = await alice.client.get('/orgs');
    expect(res.status).toBe(200);
    expect(res.body.data.map((o: { organizationId: string }) => o.organizationId)).toEqual([
      orgA.id,
    ]);
    const me = await alice.client.get('/auth/me');
    expect(me.body.memberships.map((m: { organizationId: string }) => m.organizationId)).toEqual([
      orgA.id,
    ]);
  });

  it('5. member listings never include other organisations’ users', async () => {
    const res = await bob.client.get(`/orgs/${orgB.id}/members`);
    expect(res.status).toBe(200);
    const emails = res.body.data.map((m: { email: string }) => m.email);
    expect(emails).toContain(bob.email);
    expect(emails).not.toContain(alice.email);
  });

  it('6. a user in two organisations gets the role of each organisation separately', async () => {
    const dana = await registerUser(t, 'Dana');
    const danasOwn = await createOrg(dana, 'Dana Co'); // OWNER there
    await addMemberDirect(t, orgA.id, dana.id, 'VIEWER'); // VIEWER in Org A

    expect((await dana.client.patch(`/orgs/${danasOwn.id}`, { name: 'Dana Co 2' })).status).toBe(
      200,
    );
    const denied = await dana.client.patch(`/orgs/${orgA.id}`, { name: 'Nope' });
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('FORBIDDEN');
    expect((await dana.client.get(`/orgs/${orgA.id}`)).body.role).toBe('VIEWER');
  });

  it('7. access ends immediately when membership is removed', async () => {
    const erin = await userWithRole(t, orgA.id, 'DEVELOPER');
    expect((await erin.client.get(`/orgs/${orgA.id}`)).status).toBe(200);
    expect((await alice.client.delete(`/orgs/${orgA.id}/members/${erin.memberId}`)).status).toBe(
      204,
    );
    expect((await erin.client.get(`/orgs/${orgA.id}`)).status).toBe(404);
  });

  it('8. malformed organisation ids are treated as not found (no database error leaks)', async () => {
    for (const bad of ['not-a-uuid', '1', '\'; DROP TABLE "User"; --', '%00']) {
      const res = await alice.client.get(`/orgs/${encodeURIComponent(bad)}`);
      expect(res.status).toBe(404);
      expect(JSON.stringify(res.body)).not.toMatch(/prisma|postgres|syntax/i);
    }
    expect(await t.prisma.user.count()).toBeGreaterThan(0);
  });

  it('9. unauthenticated callers get 401 on every organisation route', async () => {
    const anon = (await registerUser(t)).client;
    anon.cookie = undefined;
    for (const [method, path] of [
      ['get', `/orgs/${orgA.id}`],
      ['get', `/orgs/${orgA.id}/members`],
      ['get', '/orgs'],
    ] as const) {
      expect((await anon.send(method, path, { cookie: null })).status).toBe(401);
    }
  });

  it('10. routes with no access rule, or an org route with no permission, are denied by default', async () => {
    const noRule = await alice.client.get('/rogue');
    expect(noRule.status).toBe(403);
    expect(noRule.body.error.code).toBe('ROUTE_MISCONFIGURED');

    const noPermission = await alice.client.get(`/orgs/${orgA.id}/rogue`);
    expect(noPermission.status).toBe(403);
    expect(noPermission.body.error.code).toBe('ROUTE_MISCONFIGURED');

    // Non-members still get 404, not a hint about the misconfiguration.
    expect((await alice.client.get(`/orgs/${orgB.id}/rogue`)).status).toBe(404);
    // And anonymous callers are stopped before any of that.
    const anonymous = (await registerUser(t)).client;
    expect((await anonymous.send('get', '/rogue', { cookie: null })).status).toBe(401);
  });
});
