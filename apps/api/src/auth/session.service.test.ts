import { describe, expect, it } from 'vitest';
import {
  SessionService,
  generateToken,
  hashToken,
  type NewSession,
  type SessionStore,
  type StoredSession,
} from './session.service';

const HOUR = 3_600_000;
const POLICY = { idleMs: 2 * HOUR, absoluteMs: 10 * HOUR, touchIntervalMs: 5 * 60_000 };

class MemoryStore implements SessionStore {
  sessions = new Map<string, StoredSession & { tokenHash: string }>();
  touches = 0;
  disabledUsers = new Set<string>();
  private seq = 0;

  async create(s: NewSession): Promise<void> {
    const id = `s${++this.seq}`;
    this.sessions.set(s.tokenHash, {
      id,
      tokenHash: s.tokenHash,
      userId: s.userId,
      lastUsedAt: new Date(clock.time),
      expiresAt: s.expiresAt,
      absoluteExpiresAt: s.absoluteExpiresAt,
      revokedAt: null,
      user: { id: s.userId, email: 'u@example.com', name: 'U', disabledAt: null },
    });
  }
  async findByTokenHash(hash: string) {
    const found = this.sessions.get(hash);
    if (!found) return null;
    return {
      ...found,
      user: { ...found.user, disabledAt: this.disabledUsers.has(found.userId) ? new Date() : null },
    };
  }
  async touch(id: string, lastUsedAt: Date, expiresAt: Date) {
    this.touches++;
    for (const s of this.sessions.values())
      if (s.id === id) Object.assign(s, { lastUsedAt, expiresAt });
  }
  async revoke(id: string, at: Date) {
    for (const s of this.sessions.values()) if (s.id === id) s.revokedAt = at;
  }
  async revokeAllForUser(userId: string, at: Date) {
    let n = 0;
    for (const s of this.sessions.values()) {
      if (s.userId !== userId || s.revokedAt) continue;
      s.revokedAt = at;
      n++;
    }
    return n;
  }
}

const clock = { time: Date.parse('2026-01-01T00:00:00Z') };
const setup = () => {
  clock.time = Date.parse('2026-01-01T00:00:00Z');
  const store = new MemoryStore();
  return { store, service: new SessionService(store, POLICY, () => new Date(clock.time)) };
};

describe('token helpers', () => {
  it('generates unique, high-entropy url-safe tokens', () => {
    const tokens = new Set(Array.from({ length: 500 }, generateToken));
    expect(tokens.size).toBe(500);
    for (const token of tokens) expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('hashes deterministically to 64 hex chars and never equals the token', () => {
    const token = generateToken();
    expect(hashToken(token)).toBe(hashToken(token));
    expect(hashToken(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(token)).not.toBe(token);
  });
});

describe('SessionService', () => {
  it('stores only the hash, never the raw token', async () => {
    const { store, service } = setup();
    const { token } = await service.issue('user-1', {});
    expect([...store.sessions.keys()]).toEqual([hashToken(token)]);
    expect(JSON.stringify([...store.sessions.values()])).not.toContain(token);
  });

  it('authenticates a valid token and rejects an unknown one', async () => {
    const { service } = setup();
    const { token } = await service.issue('user-1', {});
    expect((await service.authenticate(token))?.user.id).toBe('user-1');
    expect(await service.authenticate(generateToken())).toBeNull();
  });

  it('issues a distinct token per login (no fixation)', async () => {
    const { service } = setup();
    const a = await service.issue('user-1', {});
    const b = await service.issue('user-1', {});
    expect(a.token).not.toBe(b.token);
  });

  it('expires after the idle period', async () => {
    const { service } = setup();
    const { token } = await service.issue('user-1', {});
    clock.time += 2 * HOUR + 1;
    expect(await service.authenticate(token)).toBeNull();
  });

  it('slides the idle expiry while the session is used', async () => {
    const { service } = setup();
    const { token } = await service.issue('user-1', {});
    for (let i = 0; i < 4; i++) {
      clock.time += HOUR + 30 * 60_000; // 1.5h < idle timeout each step
      expect(await service.authenticate(token)).not.toBeNull();
    }
  });

  it('never outlives the absolute lifetime, even if continuously active', async () => {
    const { service } = setup();
    const { token } = await service.issue('user-1', {});
    let alive = true;
    while (clock.time < Date.parse('2026-01-01T00:00:00Z') + 12 * HOUR && alive) {
      clock.time += HOUR;
      alive = (await service.authenticate(token)) !== null;
    }
    expect(alive).toBe(false);
    expect(clock.time).toBeLessThanOrEqual(Date.parse('2026-01-01T00:00:00Z') + 11 * HOUR);
  });

  it('rejects revoked sessions immediately', async () => {
    const { service } = setup();
    const { token } = await service.issue('user-1', {});
    await service.revokeByToken(token);
    expect(await service.authenticate(token)).toBeNull();
  });

  it('revokeAllForUser invalidates every session of that user only', async () => {
    const { service } = setup();
    const a = await service.issue('user-1', {});
    const b = await service.issue('user-1', {});
    const other = await service.issue('user-2', {});
    expect(await service.revokeAllForUser('user-1')).toBe(2);
    expect(await service.authenticate(a.token)).toBeNull();
    expect(await service.authenticate(b.token)).toBeNull();
    expect(await service.authenticate(other.token)).not.toBeNull();
  });

  it('rejects sessions of disabled users', async () => {
    const { store, service } = setup();
    const { token } = await service.issue('user-1', {});
    store.disabledUsers.add('user-1');
    expect(await service.authenticate(token)).toBeNull();
  });

  it('throttles sliding-expiry writes', async () => {
    const { store, service } = setup();
    const { token } = await service.issue('user-1', {});
    for (let i = 0; i < 10; i++) {
      clock.time += 10_000;
      await service.authenticate(token);
    }
    expect(store.touches).toBe(0);
    clock.time += 6 * 60_000;
    await service.authenticate(token);
    expect(store.touches).toBe(1);
  });
});
