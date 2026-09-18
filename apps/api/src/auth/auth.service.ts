import { Inject, Injectable } from '@nestjs/common';
import type { PrismaClient } from '@nexus/database';
import type { LoginInput, MeResponse, RegisterInput } from '@nexus/shared';
import { ApiError } from '../common/api-error';
import { PRISMA } from '../infrastructure/tokens';
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
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(PasswordService) private readonly passwords: PasswordService,
    @Inject(SessionService) private readonly sessions: SessionService,
  ) {}

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
    return { me: await this.me({ id: user.id, email: user.email, name: user.name }), session };
  }

  async logout(token: string): Promise<void> {
    await this.sessions.revokeByToken(token);
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
