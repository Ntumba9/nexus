import { createHash, randomBytes } from 'node:crypto';
import type { AuthContext } from '../common/request-context';

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  disabledAt: Date | null;
}

export interface StoredSession {
  id: string;
  userId: string;
  lastUsedAt: Date;
  expiresAt: Date;
  absoluteExpiresAt: Date;
  revokedAt: Date | null;
  user: SessionUser;
}

export interface NewSession {
  userId: string;
  tokenHash: string;
  expiresAt: Date;
  absoluteExpiresAt: Date;
  ip: string | null;
  userAgent: string | null;
}

/** Persistence boundary, so session rules can be unit-tested without a database. */
export interface SessionStore {
  create(session: NewSession): Promise<void>;
  findByTokenHash(tokenHash: string): Promise<StoredSession | null>;
  touch(id: string, lastUsedAt: Date, expiresAt: Date): Promise<void>;
  revoke(id: string, at: Date): Promise<void>;
  revokeAllForUser(userId: string, at: Date): Promise<number>;
}

export const SESSION_STORE = Symbol('SESSION_STORE');

export interface SessionPolicy {
  idleMs: number;
  absoluteMs: number;
  /** Sliding expiry is persisted at most this often, to avoid a write on every request. */
  touchIntervalMs: number;
}

export interface IssuedSession {
  /** The opaque bearer token. Only ever sent to the client in the cookie; never stored. */
  token: string;
  /** Hard expiry; used as the cookie's Expires. Idle expiry is enforced server-side. */
  expiresAt: Date;
}

export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Server-side sessions with opaque, high-entropy tokens.
 * - Only a SHA-256 of the token is stored, so a database leak does not yield usable sessions.
 * - A fresh token is issued on every login (no pre-authentication session ever exists, so there is
 *   nothing to fixate).
 * - Sessions expire after an idle period (sliding) and after an absolute lifetime, and can be
 *   revoked immediately.
 */
export class SessionService {
  constructor(
    private readonly store: SessionStore,
    private readonly policy: SessionPolicy,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async issue(
    userId: string,
    meta: { ip?: string | null; userAgent?: string | null },
  ): Promise<IssuedSession> {
    const token = generateToken();
    const now = this.now();
    const absoluteExpiresAt = new Date(now.getTime() + this.policy.absoluteMs);
    const expiresAt = new Date(
      Math.min(now.getTime() + this.policy.idleMs, absoluteExpiresAt.getTime()),
    );
    await this.store.create({
      userId,
      tokenHash: hashToken(token),
      expiresAt,
      absoluteExpiresAt,
      ip: meta.ip ?? null,
      userAgent: meta.userAgent?.slice(0, 256) ?? null,
    });
    return { token, expiresAt: absoluteExpiresAt };
  }

  /** Returns the authenticated identity, or null for unknown, expired, revoked or disabled sessions. */
  async authenticate(token: string): Promise<AuthContext | null> {
    const session = await this.store.findByTokenHash(hashToken(token));
    if (!session) return null;

    const now = this.now();
    if (session.revokedAt) return null;
    if (session.expiresAt <= now || session.absoluteExpiresAt <= now) return null;
    if (session.user.disabledAt) return null;

    if (now.getTime() - session.lastUsedAt.getTime() >= this.policy.touchIntervalMs) {
      const slid = Math.min(
        now.getTime() + this.policy.idleMs,
        session.absoluteExpiresAt.getTime(),
      );
      await this.store.touch(session.id, now, new Date(slid));
    }

    return {
      sessionId: session.id,
      user: { id: session.user.id, email: session.user.email, name: session.user.name },
    };
  }

  async revokeByToken(token: string): Promise<void> {
    const session = await this.store.findByTokenHash(hashToken(token));
    if (session && !session.revokedAt) await this.store.revoke(session.id, this.now());
  }

  revokeAllForUser(userId: string): Promise<number> {
    return this.store.revokeAllForUser(userId, this.now());
  }
}
