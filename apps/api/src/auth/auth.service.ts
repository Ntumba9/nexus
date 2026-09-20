import { createHash, randomBytes } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { writeAuditLog, type Prisma, type PrismaClient } from '@nexus/database';
import {
  EMAIL_JOBS,
  RESET_TOKEN_TTL_MINUTES,
  type AuditAction,
  type ChangePasswordInput,
  type LoginInput,
  type MeResponse,
  type PasswordResetJob,
  type RegisterInput,
} from '@nexus/shared';
import type { Queue } from 'bullmq';
import { ApiError } from '../common/api-error';
import { currentRequestId } from '../common/request-store';
import { EMAIL_QUEUE, PRISMA } from '../infrastructure/tokens';
import { PasswordService } from './password.service';
import { SessionService, type IssuedSession } from './session.service';

export interface ClientMeta {
  ip: string | null;
  userAgent: string | null;
}

export interface AuthResult {
  me: MeResponse;
  session: IssuedSession;
}

const UNIQUE_VIOLATION = 'P2002';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(PasswordService) private readonly passwords: PasswordService,
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(EMAIL_QUEUE) private readonly emailQueue: Queue,
  ) {}

  /**
   * Record something a person did to their own account in the audit log of EVERY organization they
   * belong to (an account is not owned by one organization, but each organization's administrators
   * should be able to see, for instance, that a member's password was reset). Call inside the
   * transaction that makes the change.
   */
  private async auditAccount(
    tx: Prisma.TransactionClient,
    user: { id: string; name: string },
    action: AuditAction,
    metadata: Record<string, unknown> = {},
  ): Promise<void> {
    const memberships = await tx.organizationMember.findMany({
      where: { userId: user.id },
      select: { organizationId: true },
      take: 50,
    });
    for (const { organizationId } of memberships) {
      await writeAuditLog(tx, {
        organizationId,
        actor: { type: 'USER', id: user.id, label: user.name },
        action,
        resourceType: 'user',
        resourceId: user.id,
        metadata,
        requestId: currentRequestId() ?? null,
      });
    }
  }

  async register(input: RegisterInput, meta: ClientMeta): Promise<AuthResult> {
    const passwordHash = await this.passwords.hash(input.password);
    let user;
    try {
      user = await this.prisma.user.create({
        data: { email: input.email, name: input.name, passwordHash },
        select: { id: true, email: true, name: true },
      });
    } catch (error) {
      if ((error as { code?: string }).code === UNIQUE_VIOLATION) {
        // Residual enumeration risk, accepted and documented in docs/security.md: without email
        // verification the client must be told why registration failed. Rate limited per IP.
        throw ApiError.conflict('EMAIL_TAKEN', 'An account with this email already exists');
      }
      throw error;
    }
    const session = await this.sessions.issue(user.id, meta);
    return { me: { user, memberships: [] }, session };
  }

  /**
   * Uniform failure: unknown email, wrong password and disabled account are indistinguishable in
   * both response body and (approximately) timing.
   */
  async login(input: LoginInput, meta: ClientMeta, previousToken?: string): Promise<AuthResult> {
    const user = await this.prisma.user.findUnique({
      where: { email: input.email },
      select: { id: true, email: true, name: true, passwordHash: true, disabledAt: true },
    });
    const valid = await this.passwords.verifyOrDummy(user?.passwordHash, input.password);
    if (!user || !valid || user.disabledAt) {
      throw ApiError.unauthenticated('INVALID_CREDENTIALS', 'Invalid email or password');
    }

    // A new token is always minted; if the browser already held a session, end it.
    if (previousToken) await this.sessions.revokeByToken(previousToken);
    const session = await this.sessions.issue(user.id, meta);
    // Best effort: recording a sign-in must never stop someone from signing in.
    await this.prisma
      .$transaction((tx) => this.auditAccount(tx, user, 'auth.signed_in'))
      .catch((error: unknown) =>
        this.logger.warn(
          `Could not audit a sign-in: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    return { me: await this.me({ id: user.id, email: user.email, name: user.name }), session };
  }

  async logout(token: string, user?: { id: string; name: string }): Promise<void> {
    await this.sessions.revokeByToken(token);
    if (user) {
      await this.prisma
        .$transaction((tx) => this.auditAccount(tx, user, 'auth.signed_out'))
        .catch(() => undefined);
    }
  }

  /** End every session of this person, on every device, including this one. */
  async logoutAll(user: { id: string; name: string }): Promise<number> {
    return this.prisma.$transaction(async (tx) => {
      const { count } = await tx.session.updateMany({
        where: { userId: user.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await this.auditAccount(tx, user, 'auth.signed_out_everywhere', { sessions: count });
      return count;
    });
  }

  /**
   * Change your own password. It needs the current one (a stolen session alone cannot take the account
   * over), and it ends every OTHER session, so whoever else was signed in is signed out.
   */
  async changePassword(
    user: { id: string; name: string },
    currentSessionId: string,
    input: ChangePasswordInput,
  ): Promise<void> {
    const row = await this.prisma.user.findUnique({
      where: { id: user.id },
      select: { passwordHash: true },
    });
    if (!row || !(await this.passwords.verify(row.passwordHash, input.currentPassword))) {
      throw ApiError.badRequest('INVALID_CURRENT_PASSWORD', 'Your current password is not correct');
    }
    const passwordHash = await this.passwords.hash(input.newPassword);
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: user.id }, data: { passwordHash } });
      const { count } = await tx.session.updateMany({
        where: { userId: user.id, revokedAt: null, id: { not: currentSessionId } },
        data: { revokedAt: new Date() },
      });
      // A reset link requested before the change must not still work afterwards.
      await tx.passwordReset.deleteMany({ where: { userId: user.id, usedAt: null } });
      await this.auditAccount(tx, user, 'auth.password_changed', { otherSessionsEnded: count });
    });
  }

  /**
   * Start a password reset. It ALWAYS looks the same from outside (the caller cannot tell whether the
   * address has an account): the link goes to the account's own address, by email, never in the
   * response. Only a hash of the token is kept, it works once, and it expires after an hour. Asking
   * again cancels the earlier link.
   */
  async requestPasswordReset(email: string, ip: string | null): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { email },
      select: { id: true, name: true, disabledAt: true },
    });
    if (!user || user.disabledAt) return;

    const token = randomBytes(32).toString('base64url');
    await this.prisma.$transaction(async (tx) => {
      await tx.passwordReset.deleteMany({ where: { userId: user.id, usedAt: null } });
      await tx.passwordReset.create({
        data: {
          userId: user.id,
          tokenHash: hashResetToken(token),
          expiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MINUTES * 60_000),
          ip,
        },
      });
      await this.auditAccount(tx, user, 'auth.password_reset_requested');
    });

    const requestId = currentRequestId();
    const job: PasswordResetJob = { userId: user.id, token, ...(requestId ? { requestId } : {}) };
    try {
      await this.emailQueue.add(EMAIL_JOBS.passwordReset, job, {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        // The token is in the payload: do not keep it around once it has been sent.
        removeOnComplete: true,
        removeOnFail: { age: 3600 },
      });
    } catch (error) {
      // Not revealed to the caller (that would say the account exists); the person can ask again.
      this.logger.warn(
        `Could not queue a password-reset email: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Use a reset link: set a new password, end every session, and use up the link. */
  async resetPassword(token: string, password: string): Promise<void> {
    const invalid = () =>
      ApiError.badRequest('INVALID_RESET_TOKEN', 'This reset link is invalid or has expired');
    const reset = await this.prisma.passwordReset.findUnique({
      where: { tokenHash: hashResetToken(token) },
      select: {
        id: true,
        usedAt: true,
        expiresAt: true,
        user: { select: { id: true, name: true, disabledAt: true } },
      },
    });
    if (!reset || reset.usedAt || reset.expiresAt <= new Date() || reset.user.disabledAt) {
      throw invalid();
    }
    const passwordHash = await this.passwords.hash(password);
    await this.prisma.$transaction(async (tx) => {
      // Claim the link first: of two simultaneous uses, only one can win.
      const claimed = await tx.passwordReset.updateMany({
        where: { id: reset.id, usedAt: null, expiresAt: { gt: new Date() } },
        data: { usedAt: new Date() },
      });
      if (claimed.count === 0) throw invalid();
      await tx.user.update({ where: { id: reset.user.id }, data: { passwordHash } });
      const { count } = await tx.session.updateMany({
        where: { userId: reset.user.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await tx.passwordReset.deleteMany({ where: { userId: reset.user.id, usedAt: null } });
      await this.auditAccount(tx, reset.user, 'auth.password_reset', { sessionsEnded: count });
    });
  }

  async me(user: { id: string; email: string; name: string }): Promise<MeResponse> {
    const memberships = await this.prisma.organizationMember.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'asc' },
      select: { role: true, organization: { select: { id: true, name: true, slug: true } } },
    });
    return {
      user: { id: user.id, email: user.email, name: user.name },
      memberships: memberships.map((m) => ({
        organizationId: m.organization.id,
        name: m.organization.name,
        slug: m.organization.slug,
        role: m.role,
      })),
    };
  }
}

/** Only this hash is ever stored, exactly like session tokens. */
export function hashResetToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
