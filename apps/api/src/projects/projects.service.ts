import { Inject, Injectable } from '@nestjs/common';
import type { Prisma, PrismaClient } from '@nexus/database';
import type {
  CreateProjectInput,
  CreateServiceInput,
  ProjectDto,
  ServiceDto,
  UpdateProjectInput,
  UpdateServiceInput,
} from '@nexus/shared';
import { ApiError } from '../common/api-error';
import type { TenantContext } from '../common/request-context';
import { slugify } from '../common/slug';
import { PRISMA } from '../infrastructure/tokens';

const UNIQUE_VIOLATION = 'P2002';
const isCode = (error: unknown, code: string) => (error as { code?: string }).code === code;

const projectSelect = {
  id: true,
  name: true,
  slug: true,
  description: true,
  archivedAt: true,
  createdAt: true,
  _count: { select: { services: { where: { archivedAt: null } } } },
} satisfies Prisma.ProjectSelect;

const serviceSelect = {
  id: true,
  projectId: true,
  name: true,
  environment: true,
  healthStatus: true,
  description: true,
  archivedAt: true,
  createdAt: true,
  project: { select: { name: true } },
} satisfies Prisma.ServiceSelect;

function toProjectDto(row: Prisma.ProjectGetPayload<{ select: typeof projectSelect }>): ProjectDto {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    archivedAt: row.archivedAt?.toISOString() ?? null,
    serviceCount: row._count.services,
    createdAt: row.createdAt.toISOString(),
  };
}

function toServiceDto(row: Prisma.ServiceGetPayload<{ select: typeof serviceSelect }>): ServiceDto {
  return {
    id: row.id,
    projectId: row.projectId,
    projectName: row.project.name,
    name: row.name,
    environment: row.environment,
    healthStatus: row.healthStatus,
    description: row.description,
    archivedAt: row.archivedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Every query is scoped by the verified `tenant.organizationId`. Lookups by id always include it,
 * so an id from another organisation matches nothing and yields the same 404 as an unknown id.
 */
@Injectable()
export class ProjectsService {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async list(tenant: TenantContext, includeArchived: boolean): Promise<ProjectDto[]> {
    const rows = await this.prisma.project.findMany({
      where: {
        organizationId: tenant.organizationId,
        ...(includeArchived ? {} : { archivedAt: null }),
      },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      select: projectSelect,
    });
    return rows.map(toProjectDto);
  }

  async get(tenant: TenantContext, id: string): Promise<ProjectDto> {
    const row = await this.prisma.project.findFirst({
      where: { id, organizationId: tenant.organizationId },
      select: projectSelect,
    });
    if (!row) throw ApiError.notFound('Project not found');
    return toProjectDto(row);
  }

  async create(tenant: TenantContext, input: CreateProjectInput): Promise<ProjectDto> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const row = await this.prisma.project.create({
          data: {
            organizationId: tenant.organizationId,
            name: input.name,
            description: input.description,
            slug: slugify(input.name, 'project'),
          },
          select: projectSelect,
        });
        return toProjectDto(row);
      } catch (error) {
        if (!isCode(error, UNIQUE_VIOLATION)) throw error; // slug collision: retry with a new suffix
      }
    }
    throw ApiError.conflict('SLUG_CONFLICT', 'Could not allocate a unique project identifier');
  }

  async update(tenant: TenantContext, id: string, input: UpdateProjectInput): Promise<ProjectDto> {
    const result = await this.prisma.project.updateMany({
      where: { id, organizationId: tenant.organizationId },
      data: input,
    });
    if (result.count === 0) throw ApiError.notFound('Project not found');
    return this.get(tenant, id);
  }

  /** Soft delete: history (incidents that reference its services) must survive. Idempotent. */
  async archive(tenant: TenantContext, id: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const now = new Date();
      const result = await tx.project.updateMany({
        where: { id, organizationId: tenant.organizationId, archivedAt: null },
        data: { archivedAt: now },
      });
      if (result.count === 0) {
        const exists = await tx.project.findFirst({
          where: { id, organizationId: tenant.organizationId },
          select: { id: true },
        });
        if (!exists) throw ApiError.notFound('Project not found');
        return; // already archived
      }
      await tx.service.updateMany({
        where: { projectId: id, organizationId: tenant.organizationId, archivedAt: null },
        data: { archivedAt: now },
      });
    });
  }
}

@Injectable()
export class ServicesService {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async list(
    tenant: TenantContext,
    filter: { projectId?: string; includeArchived: boolean },
  ): Promise<ServiceDto[]> {
    const rows = await this.prisma.service.findMany({
      where: {
        organizationId: tenant.organizationId,
        ...(filter.projectId ? { projectId: filter.projectId } : {}),
        ...(filter.includeArchived ? {} : { archivedAt: null }),
      },
      orderBy: [{ project: { name: 'asc' } }, { name: 'asc' }, { id: 'asc' }],
      select: serviceSelect,
    });
    return rows.map(toServiceDto);
  }

  async get(tenant: TenantContext, id: string): Promise<ServiceDto> {
    const row = await this.prisma.service.findFirst({
      where: { id, organizationId: tenant.organizationId },
      select: serviceSelect,
    });
    if (!row) throw ApiError.notFound('Service not found');
    return toServiceDto(row);
  }

  async create(
    tenant: TenantContext,
    projectId: string,
    input: CreateServiceInput,
  ): Promise<ServiceDto> {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, organizationId: tenant.organizationId },
      select: { id: true, archivedAt: true },
    });
    if (!project) throw ApiError.notFound('Project not found');
    if (project.archivedAt) {
      throw ApiError.conflict('PROJECT_ARCHIVED', 'Cannot add services to an archived project');
    }
    try {
      const row = await this.prisma.service.create({
        data: { organizationId: tenant.organizationId, projectId, ...input },
        select: serviceSelect,
      });
      return toServiceDto(row);
    } catch (error) {
      if (isCode(error, UNIQUE_VIOLATION)) {
        throw ApiError.conflict(
          'SERVICE_EXISTS',
          'A service with that name and environment already exists in this project',
        );
      }
      throw error;
    }
  }

  async update(tenant: TenantContext, id: string, input: UpdateServiceInput): Promise<ServiceDto> {
    try {
      const result = await this.prisma.service.updateMany({
        where: { id, organizationId: tenant.organizationId },
        data: input,
      });
      if (result.count === 0) throw ApiError.notFound('Service not found');
    } catch (error) {
      if (isCode(error, UNIQUE_VIOLATION)) {
        throw ApiError.conflict(
          'SERVICE_EXISTS',
          'A service with that name and environment already exists in this project',
        );
      }
      throw error;
    }
    return this.get(tenant, id);
  }

  async archive(tenant: TenantContext, id: string): Promise<void> {
    const result = await this.prisma.service.updateMany({
      where: { id, organizationId: tenant.organizationId, archivedAt: null },
      data: { archivedAt: new Date() },
    });
    if (result.count === 0) {
      const exists = await this.prisma.service.findFirst({
        where: { id, organizationId: tenant.organizationId },
        select: { id: true },
      });
      if (!exists) throw ApiError.notFound('Service not found');
    }
  }
}
