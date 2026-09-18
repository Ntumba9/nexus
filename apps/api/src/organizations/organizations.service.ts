import { randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { PrismaClient } from '@nexus/database';
import type { MembershipDto, OrganizationDetailDto } from '@nexus/shared';
import { ApiError } from '../common/api-error';
import type { TenantContext } from '../common/request-context';
import { PRISMA } from '../infrastructure/tokens';

const UNIQUE_VIOLATION = 'P2002';

export function slugify(name: string): string {
  const base = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return `${base || 'org'}-${randomBytes(3).toString('hex')}`;
}

@Injectable()
export class OrganizationsService {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  /** Any authenticated user may create an organisation; they become its first OWNER, atomically. */
  async create(userId: string, name: string): Promise<OrganizationDetailDto> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const org = await this.prisma.organization.create({
          data: { name, slug: slugify(name), members: { create: { userId, role: 'OWNER' } } },
        });
        return toDetail(org, 'OWNER');
      } catch (error) {
        if ((error as { code?: string }).code !== UNIQUE_VIOLATION) throw error;
      }
    }
    throw ApiError.conflict('SLUG_CONFLICT', 'Could not allocate a unique organization slug');
  }

  async listForUser(userId: string): Promise<MembershipDto[]> {
    const rows = await this.prisma.organizationMember.findMany({
      where: { userId },
      orderBy: { createdAt: 'asc' },
      select: { role: true, organization: { select: { id: true, name: true, slug: true } } },
    });
    return rows.map((row) => ({
      organizationId: row.organization.id,
      name: row.organization.name,
      slug: row.organization.slug,
      role: row.role,
    }));
  }

  async get(tenant: TenantContext): Promise<OrganizationDetailDto> {
    const org = await this.prisma.organization.findUnique({ where: { id: tenant.organizationId } });
    if (!org) throw ApiError.notFound('Organization not found');
    return toDetail(org, tenant.role);
  }

  async update(tenant: TenantContext, name: string): Promise<OrganizationDetailDto> {
    const org = await this.prisma.organization.update({
      where: { id: tenant.organizationId },
      data: { name },
    });
    return toDetail(org, tenant.role);
  }
}

function toDetail(
  org: { id: string; name: string; slug: string; createdAt: Date },
  role: OrganizationDetailDto['role'],
): OrganizationDetailDto {
  return {
    id: org.id,
    name: org.name,
    slug: org.slug,
    createdAt: org.createdAt.toISOString(),
    role,
  };
}
