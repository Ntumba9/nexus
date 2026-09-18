import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  createProjectSchema,
  createServiceSchema,
  listQuerySchema,
  listServicesQuerySchema,
  updateProjectSchema,
  updateServiceSchema,
  type CreateProjectInput,
  type CreateServiceInput,
  type ProjectDto,
  type ServiceDto,
  type UpdateProjectInput,
  type UpdateServiceInput,
} from '@nexus/shared';
import { ApiError } from '../common/api-error';
import type { AppRequest, TenantContext } from '../common/request-context';
import { UuidParamPipe, ZodValidationPipe } from '../common/zod.pipe';
import { RequirePermission } from '../rbac/decorators';
import { ProjectsService, ServicesService } from './projects.service';

function tenantOf(request: AppRequest): TenantContext {
  if (!request.tenant) throw ApiError.forbidden('ROUTE_MISCONFIGURED', 'Access denied');
  return request.tenant;
}

@ApiTags('projects')
@Controller('orgs/:orgId/projects')
export class ProjectsController {
  constructor(
    @Inject(ProjectsService) private readonly projects: ProjectsService,
    @Inject(ServicesService) private readonly services: ServicesService,
  ) {}

  @RequirePermission('projects.read')
  @Get()
  @ApiOperation({ summary: 'List projects' })
  async list(
    @Query(new ZodValidationPipe(listQuerySchema)) query: { includeArchived: boolean },
    @Req() request: AppRequest,
  ): Promise<{ data: ProjectDto[] }> {
    return { data: await this.projects.list(tenantOf(request), query.includeArchived) };
  }

  @RequirePermission('projects.manage')
  @Post()
  @ApiOperation({ summary: 'Create a project' })
  create(
    @Body(new ZodValidationPipe(createProjectSchema)) body: CreateProjectInput,
    @Req() request: AppRequest,
  ): Promise<ProjectDto> {
    return this.projects.create(tenantOf(request), body);
  }

  @RequirePermission('projects.read')
  @Get(':projectId')
  @ApiOperation({ summary: 'Get a project' })
  get(
    @Param('projectId', new UuidParamPipe()) projectId: string,
    @Req() request: AppRequest,
  ): Promise<ProjectDto> {
    return this.projects.get(tenantOf(request), projectId);
  }

  @RequirePermission('projects.manage')
  @Patch(':projectId')
  @ApiOperation({ summary: 'Update a project' })
  update(
    @Param('projectId', new UuidParamPipe()) projectId: string,
    @Body(new ZodValidationPipe(updateProjectSchema)) body: UpdateProjectInput,
    @Req() request: AppRequest,
  ): Promise<ProjectDto> {
    return this.projects.update(tenantOf(request), projectId, body);
  }

  @RequirePermission('projects.manage')
  @Delete(':projectId')
  @HttpCode(204)
  @ApiOperation({ summary: 'Archive a project and its services' })
  archive(
    @Param('projectId', new UuidParamPipe()) projectId: string,
    @Req() request: AppRequest,
  ): Promise<void> {
    return this.projects.archive(tenantOf(request), projectId);
  }

  @RequirePermission('services.manage')
  @Post(':projectId/services')
  @ApiOperation({ summary: 'Create a service in a project' })
  createService(
    @Param('projectId', new UuidParamPipe()) projectId: string,
    @Body(new ZodValidationPipe(createServiceSchema)) body: CreateServiceInput,
    @Req() request: AppRequest,
  ): Promise<ServiceDto> {
    return this.services.create(tenantOf(request), projectId, body);
  }
}

@ApiTags('services')
@Controller('orgs/:orgId/services')
export class ServicesController {
  constructor(@Inject(ServicesService) private readonly services: ServicesService) {}

  @RequirePermission('projects.read')
  @Get()
  @ApiOperation({ summary: 'List services (optionally for one project)' })
  async list(
    @Query(new ZodValidationPipe(listServicesQuerySchema))
    query: { projectId?: string; includeArchived: boolean },
    @Req() request: AppRequest,
  ): Promise<{ data: ServiceDto[] }> {
    return { data: await this.services.list(tenantOf(request), query) };
  }

  @RequirePermission('projects.read')
  @Get(':serviceId')
  @ApiOperation({ summary: 'Get a service' })
  get(
    @Param('serviceId', new UuidParamPipe()) serviceId: string,
    @Req() request: AppRequest,
  ): Promise<ServiceDto> {
    return this.services.get(tenantOf(request), serviceId);
  }

  @RequirePermission('services.manage')
  @Patch(':serviceId')
  @ApiOperation({ summary: 'Update a service' })
  update(
    @Param('serviceId', new UuidParamPipe()) serviceId: string,
    @Body(new ZodValidationPipe(updateServiceSchema)) body: UpdateServiceInput,
    @Req() request: AppRequest,
  ): Promise<ServiceDto> {
    return this.services.update(tenantOf(request), serviceId, body);
  }

  @RequirePermission('services.manage')
  @Delete(':serviceId')
  @HttpCode(204)
  @ApiOperation({ summary: 'Archive a service' })
  archive(
    @Param('serviceId', new UuidParamPipe()) serviceId: string,
    @Req() request: AppRequest,
  ): Promise<void> {
    return this.services.archive(tenantOf(request), serviceId);
  }
}
