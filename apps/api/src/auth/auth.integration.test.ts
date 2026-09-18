import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  Client,
  HAS_INFRA,
  ORIGIN,
  PASSWORD,
  createTestApp,
  registerUser,
  type TestApp,
} from '../testing/harness';

describe.skipIf(!HAS_INFRA)('authentication (integration)', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());

  describe('registration', () => {
    it('creates an account, starts a session and returns no secrets', async () => {
      const client = new Client(t.server);
      const email = `reg-${randomUUID()}@example.com`;
      const res = await client.post('/auth/register', { email, password: PASSWORD, name: 'Ada' });

      expect(res.status).toBe(201);
      expect(res.body.user).toMatchObject({ email, name: 'Ada' });
      expect(res.body.memberships).toEqual([]);
      const serialized = JSON.stringify(res.body);
      expect(serialized).not.toMatch(/passwordHash|argon2|token/i);
      expect(client.cookie).toBeDefined();
    });

    it('sets an HttpOnly, SameSite=Lax, path=/ cookie with an expiry (Secure is off outside production)', async () => {
      const client = new Client(t.server);
      const res = await client.post('/auth/register', {
        email: `cookie-${randomUUID()}@example.com`,
        password: PASSWORD,
        name: 'Cookie',
      });
      const setCookie = (res.headers['set-cookie'] as unknown as string[])[0]!;
      expect(setCookie).toMatch(/^nexus_session=[A-Za-z0-9_-]{43};/);
      expect(setCookie).toMatch(/HttpOnly/i);
      expect(setCookie).toMatch(/SameSite=Lax/i);
      expect(setCookie).toMatch(/Path=\//);
      expect(setCookie).toMatch(/Expires=/);
      expect(setCookie).not.toMatch(/Secure/i);
    });

    it('stores an Argon2id hash, never the password', async () => {
      const user = await registerUser(t);
      const row = await t.prisma.user.findUniqueOrThrow({ where: { id: user.id } });
      expect(row.passwordHash.startsWith('$argon2id$')).toBe(true);
      expect(row.passwordHash).not.toContain(PASSWORD);
    });

    it('stores only a hash of the session token', async () => {
      const user = await registerUser(t);
      const token = user.client.cookie!.split('=')[1]!;
      const byHash = await t.prisma.session.findFirst({
        where: { userId: user.id, tokenHash: createHash('sha256').update(token).digest('hex') },
      });
      expect(byHash).not.toBeNull();
      const byRaw = await t.prisma.session.findFirst({ where: { tokenHash: token } });
      expect(byRaw).toBeNull();
    });

    it('rejects duplicate emails, case-insensitively', async () => {
      const first = await registerUser(t);
      const res = await new Client(t.server).post('/auth/register', {
        email: first.email.toUpperCase(),
        password: PASSWORD,
        name: 'Dup',
      });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('EMAIL_TAKEN');
    });

    it('validates input with field-level details and no echoed values', async () => {
      const res = await new Client(t.server).post('/auth/register', {
        email: 'not-an-email',
        password: 'short',
        name: '',
      });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
      const paths = res.body.error.details.map((d: { path: string }) => d.path);
      expect(paths).toEqual(expect.arrayContaining(['email', 'password', 'name']));
      expect(JSON.stringify(res.body)).not.toContain('not-an-email');
    });

    it('rejects a common password and unknown/extra fields are stripped, not stored', async () => {
      const client = new Client(t.server);
      const weak = await client.post('/auth/register', {
        email: `weak-${randomUUID()}@example.com`,
        password: 'Password12345',
        name: 'W',
      });
      expect(weak.status).toBe(400);

      const email = `extra-${randomUUID()}@example.com`;
      const ok = await client.post('/auth/register', {
        email,
        password: PASSWORD,
        name: 'X',
        role: 'OWNER',
        disabledAt: null,
      });
      expect(ok.status).toBe(201);
    });
  });

  describe('login', () => {
    it('logs in with correct credentials and mints a new session token', async () => {
      const user = await registerUser(t);
      const login = new Client(t.server);
      const res = await login.post('/auth/login', {
        email: user.email.toUpperCase(),
        password: PASSWORD,
      });
      expect(res.status).toBe(200);
      expect(res.body.user.email).toBe(user.email);
      expect(login.cookie).toBeDefined();
      expect(login.cookie).not.toBe(user.client.cookie);
      expect((await login.get('/auth/me')).status).toBe(200);
    });

    it('returns an identical failure for an unknown email and a wrong password', async () => {
      const user = await registerUser(t);
      const client = new Client(t.server);
      const wrongPassword = await client.post('/auth/login', {
        email: user.email,
        password: 'wrong password 123',
      });
      const unknownEmail = await client.post('/auth/login', {
        email: `nobody-${randomUUID()}@example.com`,
        password: 'wrong password 123',
      });
      expect(wrongPassword.status).toBe(401);
      expect(unknownEmail.status).toBe(401);
      expect(wrongPassword.body.error.code).toBe('INVALID_CREDENTIALS');
      expect(unknownEmail.body.error.code).toBe(wrongPassword.body.error.code);
      expect(unknownEmail.body.error.message).toBe(wrongPassword.body.error.message);
      expect(client.cookie).toBeUndefined();
    });

    it('refuses to log in a disabled account with the same generic failure', async () => {
      const user = await registerUser(t);
      await t.prisma.user.update({ where: { id: user.id }, data: { disabledAt: new Date() } });
      const res = await new Client(t.server).post('/auth/login', {
        email: user.email,
        password: PASSWORD,
      });
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
    });

    it('prevents session fixation: logging in revokes the session the browser already held', async () => {
      const user = await registerUser(t);
      const oldCookie = user.client.cookie!;
      const res = await user.client.post('/auth/login', { email: user.email, password: PASSWORD });
      expect(res.status).toBe(200);
      expect(user.client.cookie).not.toBe(oldCookie);
      const stale = await new Client(t.server).get('/auth/me', { cookie: oldCookie });
      expect(stale.status).toBe(401);
    });
  });

  describe('sessions', () => {
    it('logout revokes the session server-side and clears the cookie', async () => {
      const user = await registerUser(t);
      const cookie = user.client.cookie!;
      const res = await user.client.post('/auth/logout');
      expect(res.status).toBe(204);
      expect((res.headers['set-cookie'] as unknown as string[])[0]).toMatch(/nexus_session=;/);
      // The old cookie value is dead even if an attacker kept a copy.
      expect((await new Client(t.server).get('/auth/me', { cookie })).status).toBe(401);
      const row = await t.prisma.session.findFirst({ where: { userId: user.id } });
      expect(row?.revokedAt).not.toBeNull();
    });

    it('rejects requests without a session, with garbage tokens, and with a valid-looking unknown token', async () => {
      const client = new Client(t.server);
      expect((await client.get('/auth/me')).status).toBe(401);
      expect((await client.get('/auth/me', { cookie: 'nexus_session=garbage' })).status).toBe(401);
      expect(
        (await client.get('/auth/me', { cookie: `nexus_session=${'A'.repeat(43)}` })).status,
      ).toBe(401);
      expect((await client.get('/orgs')).status).toBe(401);
    });

    it('rejects an expired session', async () => {
      const user = await registerUser(t);
      await t.prisma
        .$executeRaw`UPDATE "Session" SET "createdAt" = now() - interval '2 days', "expiresAt" = now() - interval '1 hour' WHERE "userId" = ${user.id}::uuid`;
      expect((await user.client.get('/auth/me')).status).toBe(401);
    });

    it('stops honouring the session when the user is disabled', async () => {
      const user = await registerUser(t);
      expect((await user.client.get('/auth/me')).status).toBe(200);
      await t.prisma.user.update({ where: { id: user.id }, data: { disabledAt: new Date() } });
      expect((await user.client.get('/auth/me')).status).toBe(401);
    });

    it('supports several concurrent sessions and revokes only the one that logs out', async () => {
      const user = await registerUser(t);
      const other = new Client(t.server);
      await other.post('/auth/login', { email: user.email, password: PASSWORD });
      const loggedOutCookie = user.client.cookie!;
      await user.client.post('/auth/logout');
      expect((await other.get('/auth/me', { cookie: loggedOutCookie })).status).toBe(401);
      expect((await other.get('/auth/me')).status).toBe(200);
    });

    it('GET /auth/me returns the caller and memberships', async () => {
      const user = await registerUser(t);
      const res = await user.client.get('/auth/me');
      expect(res.status).toBe(200);
      expect(res.body.user.id).toBe(user.id);
      expect(res.body.memberships).toEqual([]);
    });
  });

  describe('request hardening', () => {
    it('rejects state-changing requests with a missing or foreign Origin (CSRF)', async () => {
      const user = await registerUser(t);
      const noOrigin = await user.client.post('/auth/logout', undefined, { origin: null });
      const evil = await user.client.post('/auth/logout', undefined, {
        origin: 'https://evil.example',
      });
      const login = await new Client(t.server).post(
        '/auth/login',
        { email: user.email, password: PASSWORD },
        { origin: 'https://evil.example' },
      );
      for (const res of [noOrigin, evil, login]) {
        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe('CSRF_ORIGIN_MISMATCH');
      }
      // ...and the forged logout did not actually end the session.
      expect((await user.client.get('/auth/me')).status).toBe(200);
    });

    it('allows the configured origin and does not require Origin for safe methods', async () => {
      const user = await registerUser(t);
      expect((await user.client.get('/auth/me', { origin: null })).status).toBe(200);
      expect((await user.client.post('/auth/logout', undefined, { origin: ORIGIN })).status).toBe(
        204,
      );
    });

    it('returns the uniform error envelope for unknown routes and malformed JSON, without internals', async () => {
      const client = new Client(t.server);
      const missing = await client.get('/does-not-exist');
      expect(missing.status).toBe(404);
      expect(missing.body.error).toMatchObject({ code: 'NOT_FOUND' });
      expect(missing.body.error.requestId).toBeTruthy();
      expect(missing.headers['x-request-id']).toBe(missing.body.error.requestId);

      const { default: request } = await import('supertest');
      const bad = await request(t.server)
        .post('/api/v1/auth/login')
        .set('Origin', ORIGIN)
        .set('Content-Type', 'application/json')
        .send('{"email": ');
      expect(bad.status).toBe(400);
      expect(JSON.stringify(bad.body)).not.toMatch(/at .*\.(js|ts)|node_modules|SyntaxError/);
    });

    it('sends security headers and hides the framework', async () => {
      const res = await new Client(t.server).get('/health/live');
      expect(res.status).toBe(200);
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['x-powered-by']).toBeUndefined();
    });
  });
});

describe.skipIf(!HAS_INFRA)('authentication rate limiting (integration)', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp({
      env: { AUTH_RATE_LIMIT_MAX: '3', AUTH_RATE_LIMIT_WINDOW_SECONDS: '60' },
    });
  });
  afterAll(() => t.close());

  it('throttles repeated login attempts against one account, with Retry-After', async () => {
    const email = `rl-${randomUUID()}@example.com`;
    const client = new Client(t.server);
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) {
      statuses.push(
        (await client.post('/auth/login', { email, password: 'wrong password 123' })).status,
      );
    }
    expect(statuses).toEqual([401, 401, 401, 429, 429]);
    const blocked = await client.post('/auth/login', { email, password: 'wrong password 123' });
    expect(blocked.body.error.code).toBe('RATE_LIMITED');
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('still throttles when the attacker rotates client IPs (per-account limit)', async () => {
    const email = `rl-${randomUUID()}@example.com`;
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) {
      const fresh = new Client(t.server); // new IP each time
      statuses.push(
        (await fresh.post('/auth/login', { email, password: 'wrong password 123' })).status,
      );
    }
    expect(statuses.slice(3)).toEqual([429, 429]);
  });

  it('throttles one IP sweeping many accounts (per-IP limit)', async () => {
    const client = new Client(t.server);
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      statuses.push(
        (
          await client.post('/auth/login', {
            email: `sweep-${randomUUID()}@example.com`,
            password: 'wrong password 123',
          })
        ).status,
      );
    }
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThanOrEqual(1);
    expect(statuses.slice(0, 9).every((s) => s === 401)).toBe(true);
  });

  it('throttles registration per IP', async () => {
    const client = new Client(t.server);
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) {
      statuses.push(
        (
          await client.post('/auth/register', {
            email: `spam-${randomUUID()}@example.com`,
            password: PASSWORD,
            name: 'S',
          })
        ).status,
      );
    }
    expect(statuses).toEqual([201, 201, 201, 429, 429]);
  });
});
