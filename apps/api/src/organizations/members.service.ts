import { Inject, Injectable } from '@nestjs/common';
import type { Prisma, PrismaClient } from '@nexus/database';
import type { AddMemberInput, MemberDto, Role } from '@nexus/shared';
import { ApiError } from '../common/api-error';
import type { TenantContext } from '../common/request-context';
import { PRISMA } from '../infrastructure/tokens';
import { assertKeepsAnOwner, assertMayAssignRole, assertMayModifyMember } from './member-policy';

const UNIQUE_VIOLATION = 'P2002';

const memberSelect = {
  id: true,
  userId: true,
  role: true,
  createdAt: true,
  user: { select: { email: true, name: true } },
} satisfies Prisma.OrganizationMemberSelect;

type MemberRow = Prisma.OrganizationMemberGetPayload<{ select: typeof memberSelect }>;

function toDto(row: MemberRow): MemberDto {
  return {
    id: row.id,
    userId: row.userId,
    email: row.user.email,
    name: row.user.name,
    role: row.role,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Every query here is scoped by `tenant.organizationId`, taken from the verified tenant context
 * (never from the request body). A member id belonging to another organisation therefore simply
 * matches nothing, and the response is the same 404 as for a nonexistent id.
 */
@Injectable()
export class MembersService {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async list(tenant: TenantContext): Promise<MemberDto[]> {
    const rows = await this.prisma.organizationMember.findMany({
      where: { organizationId: tenant.organizationId },
      orderBy: { createdAt: 'asc' },
      select: memberSelect,
    });
    return rows.map(toDto);
  }

  async add(tenant: TenantContext, input: AddMemberInput): Promise<MemberDto> {
    assertMayAssignRole(tenant.role, input.role);

    const user = await this.prisma.user.findUnique({
      where: { email: input.email },
      select: { id: true, disabledAt: true },
    });
    // Only callers holding users.manage reach this; invitations by email replace this in a later phase.
    if (!user || user.disabledAt) throw ApiError.notFound('No account exists for that email');

    try {
      const row = await this.prisma.organizationMember.create({
        data: { organizationId: tenant.organizationId, userId: user.id, role: input.role },
        select: memberSelect,
      });
      return toDto(row);
    } catch (error) {
      if ((error as { code?: string }).code === UNIQUE_VIOLATION) {
        throw ApiError.conflict('ALREADY_MEMBER', 'That user is already a member');
      }
      throw error;
    }
  }

  async changeRole(tenant: TenantContext, memberId: string, role: Role): Promise<MemberDto> {
    return this.withLockedOrganization(tenant, async (tx) => {
      const member = await this.findMember(tx, tenant, memberId);
      assertMayModifyMember(tenant.role, member.role);
      assertMayAssignRole(tenant.role, role);
      assertKeepsAnOwner(await this.countOwners(tx, tenant), member.role, role === 'OWNER');

      await tx.organizationMember.updateMany({
        where: { id: member.id, organizationId: tenant.organizationId },
        data: { role },
      });
      return toDto({ ...member, role });
    });
  }

  async remove(tenant: TenantContext, memberId: string): Promise<void> {
    await this.withLockedOrganization(tenant, async (tx) => {
      const member = await this.findMember(tx, tenant, memberId);
      assertMayModifyMember(tenant.role, member.role);
      assertKeepsAnOwner(await this.countOwners(tx, tenant), member.role, false);

      await tx.organizationMember.deleteMany({
        where: { id: member.id, organizationId: tenant.organizationId },
      });
    });
  }

  /**
   * Serialises membership changes per organisation (row lock on the organisation), so two
   * concurrent demotions cannot both pass the "at least one owner" check.
   */
  private withLockedOrganization<T>(
    tenant: TenantContext,
    work: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Organization" WHERE "id" = ${tenant.organizationId}::uuid FOR UPDATE`;
      return work(tx);
    });
  }

  private async findMember(
    tx: Prisma.TransactionClient,
    tenant: TenantContext,
    memberId: string,
  ): Promise<MemberRow> {
    const member = await tx.organizationMember.findFirst({
      where: { id: memberId, organizationId: tenant.organizationId },
      select: memberSelect,
    });
    if (!member) throw ApiError.notFound('Member not found');
    return member;
  }

  private countOwners(tx: Prisma.TransactionClient, tenant: TenantContext): Promise<number> {
    return tx.organizationMember.count({
      where: { organizationId: tenant.organizationId, role: 'OWNER' },
    });
  }
}
