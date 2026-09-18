import type { PrismaClient } from '@nexus/database';
import type { NewSession, SessionStore, StoredSession } from './session.service';

export class PrismaSessionStore implements SessionStore {
  constructor(private readonly prisma: PrismaClient) {}

  async create(session: NewSession): Promise<void> {
    await this.prisma.session.create({ data: session });
  }

  findByTokenHash(tokenHash: string): Promise<StoredSession | null> {
    return this.prisma.session.findUnique({
      where: { tokenHash },
      select: {
        id: true,
        userId: true,
        lastUsedAt: true,
        expiresAt: true,
        absoluteExpiresAt: true,
        revokedAt: true,
        user: { select: { id: true, email: true, name: true, disabledAt: true } },
      },
    });
  }

  async touch(id: string, lastUsedAt: Date, expiresAt: Date): Promise<void> {
    await this.prisma.session.update({ where: { id }, data: { lastUsedAt, expiresAt } });
  }

  async revoke(id: string, at: Date): Promise<void> {
    await this.prisma.session.updateMany({
      where: { id, revokedAt: null },
      data: { revokedAt: at },
    });
  }

  async revokeAllForUser(userId: string, at: Date): Promise<number> {
    const result = await this.prisma.session.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: at },
    });
    return result.count;
  }
}
