import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { publishRealtime, type RealtimeTopic } from '@nexus/shared';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createProject } from '../testing/fixtures';
import {
  HAS_INFRA,
  ORIGIN,
  createOrg,
  createTestApp,
  registerUser,
  userWithRole,
  type TestApp,
  type TestUser,
} from '../testing/harness';

interface Stream {
  status: number;
  /** `event:data` pairs received so far, e.g. `change:{"topic":"projects"}`. */
  events: string[];
  waitFor(match: string, timeoutMs?: number): Promise<void>;
  /** Resolves once the server ends the stream. */
  ended: Promise<void>;
  close(): void;
}

/** A minimal SSE client, so the test exercises the real HTTP stream rather than the hub. */
function openStream(t: TestApp, cookie: string | undefined, orgId: string): Promise<Stream> {
  const { port } = t.server.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: `/api/v1/orgs/${orgId}/events`,
        headers: { Cookie: cookie ?? '', Origin: ORIGIN, Accept: 'text/event-stream' },
      },
      (res) => {
        const events: string[] = [];
        let buffer = '';
        let resolveEnded!: () => void;
        const ended = new Promise<void>((r) => (resolveEnded = r));
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          buffer += chunk;
          for (let i = buffer.indexOf('\n\n'); i >= 0; i = buffer.indexOf('\n\n')) {
            const block = buffer.slice(0, i);
            buffer = buffer.slice(i + 2);
            const event = /^event: (.*)$/m.exec(block)?.[1];
            const data = /^data: (.*)$/m.exec(block)?.[1];
            if (event) events.push(`${event}:${data ?? ''}`);
          }
        });
        res.on('end', resolveEnded);
        res.on('close', resolveEnded);
        const stream: Stream = {
          status: res.statusCode ?? 0,
          events,
          ended,
          close: () => req.destroy(),
          async waitFor(match, timeoutMs = 5000) {
            const deadline = Date.now() + timeoutMs;
            while (!events.includes(match)) {
              if (Date.now() > deadline) {
                throw new Error(`timed out waiting for ${match}; got ${JSON.stringify(events)}`);
              }
              await new Promise((r) => setTimeout(r, 25));
            }
          },
        };
        if (stream.status !== 200) {
          res.resume();
          resolve(stream);
          return;
        }
        // Resolve once the server said it is ready, so later publishes cannot race the subscribe.
        void stream.waitFor('ready:{}').then(() => resolve(stream), reject);
      },
    );
    req.on('error', reject);
    req.end();
  });
}

const change = (topic: RealtimeTopic) => `change:{"topic":"${topic}"}`;
const settle = (ms = 400) => new Promise((r) => setTimeout(r, ms));
const within = (promise: Promise<unknown>, what: string, ms = 5000) =>
  Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(what)), ms)),
  ]);
const changes = (stream: Stream) => stream.events.filter((e) => e.startsWith('change:'));

describe.skipIf(!HAS_INFRA)('real-time stream (integration)', () => {
  let t: TestApp;
  let redis: Redis;
  let owner: TestUser;
  let orgId: string;
  let viewer: TestUser & { memberId: string };
  let outsider: TestUser;
  const open: Stream[] = [];

  const connect = async (user: TestUser, org = orgId): Promise<Stream> => {
    const stream = await openStream(t, user.client.cookie, org);
    open.push(stream);
    return stream;
  };

  beforeAll(async () => {
    t = await createTestApp({ env: { REALTIME_HEARTBEAT_MS: '200' } });
    redis = new Redis(process.env.REDIS_URL!);
    owner = await registerUser(t, 'Stream Owner');
    orgId = (await createOrg(owner, 'Stream Org')).id;
    viewer = await userWithRole(t, orgId, 'VIEWER');
    outsider = await registerUser(t, 'Stream Outsider');
  });
  afterAll(async () => {
    for (const stream of open) stream.close();
    await redis.quit();
    await t.close();
  });

  it('requires a session and membership', async () => {
    const anonymous = await openStream(t, undefined, orgId);
    expect(anonymous.status).toBe(401);
    const foreign = await openStream(t, outsider.client.cookie, orgId);
    // The same answer as for an organisation that does not exist.
    expect(foreign.status).toBe(404);
  });

  it('sends event-stream headers that stop proxies buffering', async () => {
    const { port } = t.server.address() as AddressInfo;
    const headers = await new Promise<http.IncomingHttpHeaders>((resolve, reject) => {
      const req = http.get(
        {
          host: '127.0.0.1',
          port,
          path: `/api/v1/orgs/${orgId}/events`,
          headers: { Cookie: owner.client.cookie ?? '' },
        },
        (res) => {
          resolve(res.headers);
          req.destroy();
        },
      );
      req.on('error', reject);
    });
    expect(headers['content-type']).toContain('text/event-stream');
    expect(headers['cache-control']).toContain('no-cache');
    expect(headers['x-accel-buffering']).toBe('no');
  });

  it('announces a change made through the API to every member of that organisation', async () => {
    const a = await connect(owner);
    const b = await connect(viewer);
    await createProject(owner, orgId, 'Live project');
    await a.waitFor(change('projects'));
    await b.waitFor(change('projects'));
  });

  it("never leaks one organisation's activity into another's stream", async () => {
    const otherOrg = await createOrg(outsider, 'Second Org');
    const theirs = await connect(outsider, otherOrg.id);
    await createProject(owner, orgId, 'Private project');
    await settle();
    expect(changes(theirs)).toEqual([]);
  });

  it('does not tell a member about topics they may not read', async () => {
    const admin = await connect(owner);
    const limited = await connect(viewer);
    // Automation is for administrators; incidents are readable by everyone.
    await publishRealtime(redis, orgId, [{ topic: 'automation' }, { topic: 'incidents' }]);
    await admin.waitFor(change('automation'));
    await admin.waitFor(change('incidents'));
    await limited.waitFor(change('incidents'));
    expect(limited.events).not.toContain(change('automation'));
  });

  it('delivers a notification signal only to the person it is for', async () => {
    const mine = await connect(owner);
    const theirs = await connect(viewer);
    await publishRealtime(redis, orgId, [{ topic: 'notifications', userId: viewer.id }]);
    await theirs.waitFor(change('notifications'));
    await settle();
    expect(mine.events).not.toContain(change('notifications'));
  });

  it('ignores malformed and foreign messages', async () => {
    const stream = await connect(owner);
    await redis.publish(`nexus:rt:${orgId}`, 'not json');
    await redis.publish(`nexus:rt:${orgId}`, '{"topic":"bogus"}');
    await redis.publish('nexus:rt:not-an-org', '{"topic":"incidents"}');
    await publishRealtime(redis, orgId, [{ topic: 'members' }]);
    await stream.waitFor(change('members'));
    expect(changes(stream)).toEqual([change('members')]);
  });

  it('ends the stream when the member is removed from the organisation', async () => {
    const leaver = await userWithRole(t, orgId, 'DEVELOPER');
    const stream = await connect(leaver);
    await t.prisma.organizationMember.delete({ where: { id: leaver.memberId } });
    await within(stream.ended, 'stream stayed open after the member was removed');
  });

  it('ends the stream when the session is revoked (logout)', async () => {
    const user = await userWithRole(t, orgId, 'DEVELOPER');
    const stream = await connect(user);
    const out = await user.client.post('/auth/logout');
    expect(out.status).toBeLessThan(300);
    await within(stream.ended, 'stream stayed open after logout');
  });

  it('limits how many streams one user can hold open', async () => {
    const user = await userWithRole(t, orgId, 'SUPPORT');
    const streams: Stream[] = [];
    for (let i = 0; i < 10; i += 1) streams.push(await connect(user));
    const extra = await openStream(t, user.client.cookie, orgId);
    expect(extra.status).toBe(429);
    for (const stream of streams) stream.close();
    await settle();
    const again = await connect(user);
    expect(again.status).toBe(200);
  });
});
