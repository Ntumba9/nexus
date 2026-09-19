import { randomInt, randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { Type } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { apiEnvSchema, loadEnv, type ApiEnv } from '@nexus/config';
import type { PrismaClient } from '@nexus/database';
import type { Role } from '@nexus/shared';
import request from 'supertest';
import { AppModule } from '../app.module';
import { configureApp } from '../app.setup';
import { PRISMA } from '../infrastructure/tokens';

/** Integration tests need real PostgreSQL + Redis; they skip themselves when those are absent. */
export const HAS_INFRA = Boolean(process.env.DATABASE_URL && process.env.REDIS_URL);

export const ORIGIN = 'http://localhost:3000';
export const PASSWORD = 'correct horse battery staple';

export interface TestApp {
  app: NestExpressApplication;
  prisma: PrismaClient;
  env: ApiEnv;
  server: Server;
  close(): Promise<void>;
}

/**
 * Boots the real AppModule through the same `configureApp` used in production (prefix, CSRF check,
 * headers, error filter), against the real database and Redis.
 */
export async function createTestApp(
  options: { env?: Record<string, string>; controllers?: Type[] } = {},
): Promise<TestApp> {
  Object.assign(process.env, {
    NODE_ENV: 'test',
    WEB_ORIGIN: ORIGIN,
    TRUST_PROXY_HOPS: '1',
    AUTH_RATE_LIMIT_MAX: '100000',
    SWAGGER_ENABLED: 'false',
    ...options.env,
  });
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
    controllers: options.controllers ?? [],
  }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({ rawBody: true });
  const env = loadEnv(apiEnvSchema);
  configureApp(app, env);
  await app.init();
  return {
    app,
    env,
    prisma: app.get<PrismaClient>(PRISMA),
    server: app.getHttpServer() as Server,
    close: () => app.close(),
  };
}

type Method = 'get' | 'post' | 'patch' | 'put' | 'delete';

interface SendOptions {
  body?: unknown;
  /** `null` omits the Origin header entirely. */
  origin?: string | null;
  /** `null` sends no cookie even if the client has one. */
  cookie?: string | null;
}

/** A browser-like client: keeps the session cookie, sends a valid Origin, and has its own client IP. */
export class Client {
  cookie: string | undefined;
  readonly ip = `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`;

  constructor(private readonly server: Server) {}

  async send(method: Method, path: string, options: SendOptions = {}): Promise<request.Response> {
    const url = path.startsWith('/health') ? path : `/api/v1${path}`;
    const req = request(this.server)[method](url).set('X-Forwarded-For', this.ip);
    const origin = options.origin === undefined ? ORIGIN : options.origin;
    if (origin !== null) req.set('Origin', origin);
    const cookie = options.cookie === undefined ? this.cookie : options.cookie;
    if (cookie) req.set('Cookie', cookie);
    if (options.body !== undefined) req.send(options.body as object);
    const res = await req;
    this.captureCookie(res);
    return res;
  }

  get(path: string, options?: SendOptions): Promise<request.Response> {
    return this.send('get', path, options);
  }
  post(path: string, body?: unknown, options?: SendOptions): Promise<request.Response> {
    return this.send('post', path, { ...options, body });
  }
  patch(path: string, body?: unknown, options?: SendOptions): Promise<request.Response> {
    return this.send('patch', path, { ...options, body });
  }
  put(path: string, body?: unknown, options?: SendOptions): Promise<request.Response> {
    return this.send('put', path, { ...options, body });
  }
  delete(path: string, options?: SendOptions): Promise<request.Response> {
    return this.send('delete', path, options);
  }

  private captureCookie(res: request.Response): void {
    const header = res.headers['set-cookie'] as string[] | string | undefined;
    const cookies = Array.isArray(header) ? header : header ? [header] : [];
    const session = cookies.find((c) => c.startsWith('nexus_session='));
    if (!session) return;
    const value = session.split(';')[0]!.slice('nexus_session='.length);
    this.cookie = value ? `nexus_session=${value}` : undefined;
  }
}

export interface TestUser {
  client: Client;
  id: string;
  email: string;
}

export async function registerUser(t: TestApp, name = 'Test User'): Promise<TestUser> {
  const client = new Client(t.server);
  const email = `user-${randomUUID()}@example.com`;
  const res = await client.post('/auth/register', { email, password: PASSWORD, name });
  if (res.status !== 201)
    throw new Error(`register failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { client, id: res.body.user.id as string, email };
}

export async function createOrg(
  user: TestUser,
  name = 'Acme Technologies',
): Promise<{ id: string; name: string }> {
  const res = await user.client.post('/orgs', { name });
  if (res.status !== 201)
    throw new Error(`create org failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body as { id: string; name: string };
}

/** Insert a membership directly (bypassing the API) and return the member id. */
export async function addMemberDirect(
  t: TestApp,
  organizationId: string,
  userId: string,
  role: Role,
): Promise<string> {
  const row = await t.prisma.organizationMember.create({
    data: { organizationId, userId, role },
    select: { id: true },
  });
  return row.id;
}

/** A registered user holding `role` in the organisation. */
export async function userWithRole(
  t: TestApp,
  organizationId: string,
  role: Role,
): Promise<TestUser & { memberId: string }> {
  const user = await registerUser(t, `${role} user`);
  const memberId = await addMemberDirect(t, organizationId, user.id, role);
  return { ...user, memberId };
}
