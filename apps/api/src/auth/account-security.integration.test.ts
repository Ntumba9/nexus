import { createHash } from 'node:crypto';
import { QUEUE_NAMES, type AuditLogPageDto, type PasswordResetJob } from '@nexus/shared';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  Client,
  HAS_INFRA,
  PASSWORD,
  createOrg,
  registerUser,
  createTestApp,
  userWithRole,
  type TestApp,
  type TestUser,
} from '../testing/harness';

const NEW_PASSWORD = 'a brand new passphrase 42';

describe.skipIf(!HAS_INFRA)('account security and audit coverage (integration)', () => {
  let t: TestApp;
  let redis: Redis;
  let emailQueue: Queue;

  beforeAll(async () => {
    t = await createTestApp();
    redis = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: null });
    emailQueue = new Queue(QUEUE_NAMES.email, { connection: redis });
  });
  afterAll(async () => {
    await emailQueue.close();
    await redis.quit();
    await t.close();
  });

  /** A second browser signed in as the same person. */
  async function signInAgain(user: TestUser): Promise<Client> {
    const client = new Client(t.server);
    const res = await client.post('/auth/login', { email: user.email, password: PASSWORD });
    expect(res.status).toBe(200);
    return client;
  }
  const isSignedIn = async (client: Client) => (await client.get('/auth/me')).status === 200;

  /** The reset token the API queued for this person (what the worker would email). */
  async function queuedToken(userId: string): Promise<string> {
    const jobs = await emailQueue.getJobs(['waiting', 'delayed', 'active', 'prioritized']);
    const mine = jobs
      .filter((job) => (job.data as PasswordResetJob).userId === userId)
      .sort((a, b) => b.timestamp - a.timestamp);
    if (mine.length === 0) throw new Error('no reset email was queued');
    return (mine[0]!.data as PasswordResetJob).token;
  }

  const auditOf = async (owner: TestUser, orgId: string) =>
    ((await owner.client.get(`/orgs/${orgId}/audit-logs?limit=100`)).body as AuditLogPageDto).data;

  describe('audit coverage', () => {
    it('records sign-in, sign-out and sign-out-everywhere in each of the person’s organizations', async () => {
      const owner = await registerUser(t, 'Audited Owner');
      const orgA = (await createOrg(owner, 'Audit A')).id;
      const orgB = (await createOrg(owner, 'Audit B')).id;

      const second = await signInAgain(owner);
      await second.post('/auth/logout');
      const third = await signInAgain(owner);
      const ended = await third.post('/auth/logout-all');
      expect(ended.status).toBe(204);

      // Signing in again to read the log.
      const reader = { ...owner, client: await signInAgain(owner) } as TestUser;
      for (const org of [orgA, orgB]) {
        const actions = (await auditOf(reader, org)).map((e) => e.action);
        expect(actions, org).toEqual(
          expect.arrayContaining([
            'auth.signed_in',
            'auth.signed_out',
            'auth.signed_out_everywhere',
          ]),
        );
      }
      const entry = (await auditOf(reader, orgA)).find(
        (e) => e.action === 'auth.signed_out_everywhere',
      )!;
      expect(entry).toMatchObject({
        actorLabel: 'Audited Owner',
        actorType: 'USER',
        resourceType: 'user',
      });
      expect(Number(entry.metadata.sessions)).toBeGreaterThanOrEqual(2);
    });

    it('records who added, re-roled and removed a member, and who renamed the organization', async () => {
      const owner = await registerUser(t, 'Org Admin');
      const orgId = (await createOrg(owner, 'Members Audit')).id;
      const guest = await registerUser(t, 'Guest Person');

      const added = await owner.client.post(`/orgs/${orgId}/members`, {
        email: guest.email,
        role: 'VIEWER',
      });
      expect(added.status).toBe(201);
      const memberId = added.body.id as string;
      expect(
        (await owner.client.patch(`/orgs/${orgId}/members/${memberId}`, { role: 'DEVELOPER' }))
          .status,
      ).toBe(200);
      expect(
        (await owner.client.patch(`/orgs/${orgId}`, { name: 'Members Audit Renamed' })).status,
      ).toBe(200);
      expect((await owner.client.delete(`/orgs/${orgId}/members/${memberId}`)).status).toBe(204);

      const log = await auditOf(owner, orgId);
      const find = (action: string) => log.find((e) => e.action === action)!;
      expect(find('member.added')).toMatchObject({ actorLabel: 'Org Admin', resourceId: memberId });
      expect(find('member.added').metadata).toMatchObject({ name: 'Guest Person', role: 'VIEWER' });
      expect(find('member.role_changed').metadata).toMatchObject({
        name: 'Guest Person',
        from: 'VIEWER',
        to: 'DEVELOPER',
      });
      expect(find('member.removed').metadata).toMatchObject({
        name: 'Guest Person',
        role: 'DEVELOPER',
      });
      expect(find('organization.updated').metadata).toMatchObject({
        name: 'Members Audit Renamed',
        previous: 'Members Audit',
      });
      // Nobody's email address is copied into the log.
      expect(JSON.stringify(log)).not.toContain(guest.email);
    });

    it('records project and service changes, with the request id that caused them', async () => {
      const owner = await registerUser(t, 'Builder');
      const orgId = (await createOrg(owner, 'Build Audit')).id;

      const created = await owner.client.post(`/orgs/${orgId}/projects`, { name: 'Payments' });
      const requestId = created.headers['x-request-id'] as string;
      const projectId = created.body.id as string;
      await owner.client.patch(`/orgs/${orgId}/projects/${projectId}`, {
        description: 'Money things',
      });
      const svc = await owner.client.post(`/orgs/${orgId}/projects/${projectId}/services`, {
        name: 'API',
        environment: 'PRODUCTION',
      });
      await owner.client.patch(`/orgs/${orgId}/services/${svc.body.id}`, {
        description: 'The API',
      });
      await owner.client.delete(`/orgs/${orgId}/services/${svc.body.id}`);
      await owner.client.delete(`/orgs/${orgId}/projects/${projectId}`);

      const actions = (await auditOf(owner, orgId)).map((e) => e.action);
      for (const action of [
        'project.created',
        'project.updated',
        'project.archived',
        'service.created',
        'service.updated',
        'service.archived',
      ]) {
        expect(actions, action).toContain(action);
      }
      // The database row carries the id of the HTTP request, so a log line and an audit entry link up.
      const row = await t.prisma.auditLog.findFirstOrThrow({
        where: { organizationId: orgId, action: 'project.created' },
      });
      expect(row.requestId).toBe(requestId);
    });

    it('does not record a change that did not happen', async () => {
      const owner = await registerUser(t, 'Careful');
      const orgId = (await createOrg(owner, 'No Phantom')).id;
      const before = (await auditOf(owner, orgId)).length;
      expect(
        (
          await owner.client.patch(`/orgs/${orgId}/projects/00000000-0000-4000-8000-000000000000`, {
            description: 'x',
          })
        ).status,
      ).toBe(404);
      expect((await owner.client.post(`/orgs/${orgId}/projects`, { name: '' })).status).toBe(400);
      expect((await auditOf(owner, orgId)).length).toBe(before);
    });

    it('a viewer cannot read the audit log', async () => {
      const owner = await registerUser(t, 'Log Owner');
      const orgId = (await createOrg(owner, 'Log Org')).id;
      const viewer = await userWithRole(t, orgId, 'VIEWER');
      expect((await viewer.client.get(`/orgs/${orgId}/audit-logs`)).status).toBe(403);
    });
  });

  describe('sign out everywhere', () => {
    it('ends every session on every device, including this one', async () => {
      const user = await registerUser(t, 'Everywhere');
      const other = await signInAgain(user);
      expect(await isSignedIn(user.client)).toBe(true);
      expect(await isSignedIn(other)).toBe(true);

      const res = await other.post('/auth/logout-all');
      expect(res.status).toBe(204);
      expect(await isSignedIn(user.client)).toBe(false);
      expect(await isSignedIn(other)).toBe(false);
      // Signing in again works: the account is fine, only the sessions ended.
      expect(
        (await new Client(t.server).post('/auth/login', { email: user.email, password: PASSWORD }))
          .status,
      ).toBe(200);
    });

    it('needs a session', async () => {
      const user = await registerUser(t, 'Nobody');
      expect((await user.client.post('/auth/logout-all', undefined, { cookie: null })).status).toBe(
        401,
      );
    });
  });

  describe('change password', () => {
    it('needs the current password, is a 400 (not a sign-out) when it is wrong, and changes nothing', async () => {
      const user = await registerUser(t, 'Changer');
      const res = await user.client.post('/auth/change-password', {
        currentPassword: 'not it at all',
        newPassword: NEW_PASSWORD,
      });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_CURRENT_PASSWORD');
      expect(await isSignedIn(user.client)).toBe(true);
      expect(
        (await new Client(t.server).post('/auth/login', { email: user.email, password: PASSWORD }))
          .status,
      ).toBe(200);
    });

    it('applies the password policy and refuses an unchanged password', async () => {
      const user = await registerUser(t, 'Policy');
      for (const newPassword of ['short', 'password1234', PASSWORD]) {
        const res = await user.client.post('/auth/change-password', {
          currentPassword: PASSWORD,
          newPassword,
        });
        expect(res.status, newPassword).toBe(400);
        expect(res.body.error.code).toBe('VALIDATION_FAILED');
      }
    });

    it('changes the password, keeps this session and ends every other one', async () => {
      const user = await registerUser(t, 'Rotator');
      const other = await signInAgain(user);
      const res = await user.client.post('/auth/change-password', {
        currentPassword: PASSWORD,
        newPassword: NEW_PASSWORD,
      });
      expect(res.status).toBe(204);

      expect(await isSignedIn(user.client)).toBe(true); // the one that changed it stays in
      expect(await isSignedIn(other)).toBe(false); // everyone else is out
      expect(
        (await new Client(t.server).post('/auth/login', { email: user.email, password: PASSWORD }))
          .status,
      ).toBe(401);
      expect(
        (
          await new Client(t.server).post('/auth/login', {
            email: user.email,
            password: NEW_PASSWORD,
          })
        ).status,
      ).toBe(200);
      // Stored as an Argon2id hash, never the password.
      const row = await t.prisma.user.findUniqueOrThrow({ where: { id: user.id } });
      expect(row.passwordHash).toMatch(/^\$argon2id\$/);
      expect(row.passwordHash).not.toContain(NEW_PASSWORD);
    });

    it('is audited in the person’s organizations, and cancels a reset link asked for earlier', async () => {
      const user = await registerUser(t, 'Audited Changer');
      const orgId = (await createOrg(user, 'Change Audit')).id;
      await new Client(t.server).post('/auth/forgot-password', { email: user.email });
      expect(await t.prisma.passwordReset.count({ where: { userId: user.id } })).toBe(1);

      await user.client.post('/auth/change-password', {
        currentPassword: PASSWORD,
        newPassword: NEW_PASSWORD,
      });
      expect(await t.prisma.passwordReset.count({ where: { userId: user.id } })).toBe(0);
      const entry = (await auditOf(user, orgId)).find((e) => e.action === 'auth.password_changed')!;
      expect(entry).toMatchObject({ actorLabel: 'Audited Changer' });
      expect(JSON.stringify(entry)).not.toContain(NEW_PASSWORD);
    });

    it('needs a session', async () => {
      const user = await registerUser(t, 'No Session');
      const res = await user.client.post(
        '/auth/change-password',
        { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
        { cookie: null },
      );
      expect(res.status).toBe(401);
    });
  });

  describe('forgot password', () => {
    it('answers identically for an address with an account and one without, and reveals nothing', async () => {
      const user = await registerUser(t, 'Forgetful');
      const known = await new Client(t.server).post('/auth/forgot-password', { email: user.email });
      const unknown = await new Client(t.server).post('/auth/forgot-password', {
        email: `nobody-${Date.now()}@example.com`,
      });
      expect(known.status).toBe(202);
      expect(unknown.status).toBe(202);
      expect(known.body).toEqual(unknown.body);
      expect(known.body).toEqual({ accepted: true });
      expect(JSON.stringify(known.body) + JSON.stringify(known.headers)).not.toMatch(
        /token|reset-password/i,
      );
    });

    it('queues a link for the account, stores only its hash, and it expires in an hour', async () => {
      const user = await registerUser(t, 'Hash Check');
      await new Client(t.server).post('/auth/forgot-password', { email: user.email });
      const token = await queuedToken(user.id);
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);

      const row = await t.prisma.passwordReset.findFirstOrThrow({ where: { userId: user.id } });
      expect(row.tokenHash).toBe(createHash('sha256').update(token).digest('hex'));
      expect(JSON.stringify(row)).not.toContain(token);
      const minutes = (row.expiresAt.getTime() - row.createdAt.getTime()) / 60_000;
      expect(minutes).toBeGreaterThan(59);
      expect(minutes).toBeLessThanOrEqual(60.1);
      // The job names the account; it does not carry an address to send to.
      const job = (await emailQueue.getJobs(['waiting', 'delayed', 'active', 'prioritized'])).find(
        (j) => (j.data as PasswordResetJob).userId === user.id,
      )!;
      // (plus the id of the request that caused it, for correlating logs)
      expect(Object.keys(job.data).sort()).toEqual(['requestId', 'token', 'userId']);
      expect(JSON.stringify(job.data)).not.toContain(user.email);
    });

    it('does nothing for a disabled account, and a newer link cancels the older one', async () => {
      const disabled = await registerUser(t, 'Disabled One');
      await t.prisma.user.update({ where: { id: disabled.id }, data: { disabledAt: new Date() } });
      expect(
        (await new Client(t.server).post('/auth/forgot-password', { email: disabled.email }))
          .status,
      ).toBe(202);
      expect(await t.prisma.passwordReset.count({ where: { userId: disabled.id } })).toBe(0);

      const user = await registerUser(t, 'Twice');
      await new Client(t.server).post('/auth/forgot-password', { email: user.email });
      const first = await queuedToken(user.id);
      await new Client(t.server).post('/auth/forgot-password', { email: user.email });
      const second = await queuedToken(user.id);
      expect(second).not.toBe(first);
      expect(await t.prisma.passwordReset.count({ where: { userId: user.id } })).toBe(1);
      expect(
        (
          await new Client(t.server).post('/auth/reset-password', {
            token: first,
            password: NEW_PASSWORD,
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await new Client(t.server).post('/auth/reset-password', {
            token: second,
            password: NEW_PASSWORD,
          })
        ).status,
      ).toBe(204);
    });

    it('is limited per address, and validates the address', async () => {
      const user = await registerUser(t, 'Flooded');
      const statuses: number[] = [];
      for (let i = 0; i < 4; i += 1)
        statuses.push(
          (await new Client(t.server).post('/auth/forgot-password', { email: user.email })).status,
        );
      expect(statuses).toEqual([202, 202, 202, 429]);
      expect(
        (await new Client(t.server).post('/auth/forgot-password', { email: 'not an email' }))
          .status,
      ).toBe(400);
    });
  });

  describe('reset password', () => {
    async function requested(name: string) {
      const user = await registerUser(t, name);
      const orgId = (await createOrg(user, `${name} Org`)).id;
      await new Client(t.server).post('/auth/forgot-password', { email: user.email });
      return { user, orgId, token: await queuedToken(user.id) };
    }

    it('sets the new password, ends every session and uses up the link', async () => {
      const { user, orgId, token } = await requested('Resetter');
      const other = await signInAgain(user);
      const res = await new Client(t.server).post('/auth/reset-password', {
        token,
        password: NEW_PASSWORD,
      });
      expect(res.status).toBe(204);

      expect(await isSignedIn(user.client)).toBe(false);
      expect(await isSignedIn(other)).toBe(false);
      expect(
        (await new Client(t.server).post('/auth/login', { email: user.email, password: PASSWORD }))
          .status,
      ).toBe(401);
      const fresh = new Client(t.server);
      expect(
        (await fresh.post('/auth/login', { email: user.email, password: NEW_PASSWORD })).status,
      ).toBe(200);

      // Single use.
      const again = await new Client(t.server).post('/auth/reset-password', {
        token,
        password: `${NEW_PASSWORD} again`,
      });
      expect(again.status).toBe(400);
      expect(again.body.error.code).toBe('INVALID_RESET_TOKEN');

      const entries = await auditOf({ client: fresh } as TestUser, orgId);
      expect(entries.map((e) => e.action)).toEqual(
        expect.arrayContaining(['auth.password_reset_requested', 'auth.password_reset']),
      );
      expect(JSON.stringify(entries)).not.toContain(token);
    });

    it('refuses an expired link, an unknown one and a malformed one with the same answer', async () => {
      const { user, token } = await requested('Expirer');
      await t.prisma.passwordReset.updateMany({
        where: { userId: user.id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      const bodies: unknown[] = [];
      for (const bad of [token, 'A'.repeat(43), 'nope']) {
        const res = await new Client(t.server).post('/auth/reset-password', {
          token: bad,
          password: NEW_PASSWORD,
        });
        expect(res.status).toBe(400);
        bodies.push(res.body.error.message);
      }
      // Expired and unknown read the same; a malformed one is a validation error about the link.
      expect(bodies[0]).toBe(bodies[1]);
      // The password did not change.
      expect(
        (await new Client(t.server).post('/auth/login', { email: user.email, password: PASSWORD }))
          .status,
      ).toBe(200);
    });

    it('applies the password policy without using up the link', async () => {
      const { user, token } = await requested('Policy Reset');
      for (const password of ['short', 'password1234']) {
        expect(
          (await new Client(t.server).post('/auth/reset-password', { token, password })).status,
        ).toBe(400);
      }
      expect(
        (await new Client(t.server).post('/auth/reset-password', { token, password: NEW_PASSWORD }))
          .status,
      ).toBe(204);
      expect(
        (
          await new Client(t.server).post('/auth/login', {
            email: user.email,
            password: NEW_PASSWORD,
          })
        ).status,
      ).toBe(200);
    });

    it('lets only one of several simultaneous uses win', async () => {
      const { user, token } = await requested('Racer');
      const results = await Promise.all(
        [1, 2, 3, 4].map((i) =>
          new Client(t.server).post('/auth/reset-password', {
            token,
            password: `${NEW_PASSWORD} ${i}`,
          }),
        ),
      );
      expect(results.map((r) => r.status).sort()).toEqual([204, 400, 400, 400]);
      // Exactly one of the four passwords is now the password.
      let working = 0;
      for (const i of [1, 2, 3, 4]) {
        const res = await new Client(t.server).post('/auth/login', {
          email: user.email,
          password: `${NEW_PASSWORD} ${i}`,
        });
        if (res.status === 200) working += 1;
      }
      expect(working).toBe(1);
    });

    it('refuses the link of an account that has since been disabled', async () => {
      const { user, token } = await requested('Later Disabled');
      await t.prisma.user.update({ where: { id: user.id }, data: { disabledAt: new Date() } });
      expect(
        (await new Client(t.server).post('/auth/reset-password', { token, password: NEW_PASSWORD }))
          .status,
      ).toBe(400);
    });

    it('a link for one account cannot reset another', async () => {
      const a = await requested('Account A');
      const b = await requested('Account B');
      await new Client(t.server).post('/auth/reset-password', {
        token: a.token,
        password: NEW_PASSWORD,
      });
      expect(
        (
          await new Client(t.server).post('/auth/login', {
            email: b.user.email,
            password: PASSWORD,
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await new Client(t.server).post('/auth/login', {
            email: a.user.email,
            password: NEW_PASSWORD,
          })
        ).status,
      ).toBe(200);
    });
  });
});
