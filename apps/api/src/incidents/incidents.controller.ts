import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  addCommentSchema,
  createIncidentSchema,
  listIncidentsQuerySchema,
  setAssigneesSchema,
  transitionIncidentSchema,
  updateIncidentSchema,
  type AddCommentInput,
  type CreateIncidentInput,
  type IncidentDetailDto,
  type IncidentEventDto,
  type IncidentPageDto,
  type ListIncidentsQuery,
  type SetAssigneesInput,
  type TransitionIncidentInput,
  type UpdateIncidentInput,
} from '@nexus/shared';
import { ApiError } from '../common/api-error';
import type { AppRequest, TenantContext } from '../common/request-context';
import { UuidParamPipe, ZodValidationPipe } from '../common/zod.pipe';
import { RequirePermission } from '../rbac/decorators';
import { IncidentsService } from './incidents.service';

function tenantOf(request: AppRequest): TenantContext {
  if (!request.tenant) throw ApiError.forbidden('ROUTE_MISCONFIGURED', 'Access denied');
  return request.tenant;
}

const idPipe = new UuidParamPipe();

@ApiTags('incidents')
@Controller('orgs/:orgId/incidents')
export class IncidentsController {
  constructor(@Inject(IncidentsService) private readonly incidents: IncidentsService) {}

  @RequirePermission('incidents.read')
  @Get()
  @ApiOperation({ summary: 'List incidents (filter by status, severity, service, text)' })
  list(
    @Query(new ZodValidationPipe(listIncidentsQuerySchema)) query: ListIncidentsQuery,
    @Req() request: AppRequest,
  ): Promise<IncidentPageDto> {
    return this.incidents.list(tenantOf(request), query);
  }

  @RequirePermission('incidents.create')
  @Post()
  @ApiOperation({ summary: 'Open an incident' })
  create(
    @Body(new ZodValidationPipe(createIncidentSchema)) body: CreateIncidentInput,
    @Req() request: AppRequest,
  ): Promise<IncidentDetailDto> {
    return this.incidents.create(tenantOf(request), body);
  }

  @RequirePermission('incidents.read')
  @Get(':incidentId')
  @ApiOperation({ summary: 'Incident details' })
  get(
    @Param('incidentId', idPipe) incidentId: string,
    @Req() request: AppRequest,
  ): Promise<IncidentDetailDto> {
    return this.incidents.get(tenantOf(request), incidentId);
  }

  @RequirePermission('incidents.update')
  @Patch(':incidentId')
  @ApiOperation({ summary: 'Edit title, description, severity or tags' })
  update(
    @Param('incidentId', idPipe) incidentId: string,
    @Body(new ZodValidationPipe(updateIncidentSchema)) body: UpdateIncidentInput,
    @Req() request: AppRequest,
  ): Promise<IncidentDetailDto> {
    return this.incidents.update(tenantOf(request), incidentId, body);
  }

  /**
   * The route needs `incidents.update`; resolving or reopening additionally needs
   * `incidents.resolve`, which depends on the requested status, so the service checks it.
   */
  @RequirePermission('incidents.update')
  @Post(':incidentId/transitions')
  @HttpCode(200)
  @ApiOperation({ summary: 'Move an incident through its lifecycle' })
  transition(
    @Param('incidentId', idPipe) incidentId: string,
    @Body(new ZodValidationPipe(transitionIncidentSchema)) body: TransitionIncidentInput,
    @Req() request: AppRequest,
  ): Promise<IncidentDetailDto> {
    return this.incidents.transition(tenantOf(request), incidentId, body);
  }

  @RequirePermission('incidents.read')
  @Get(':incidentId/events')
  @ApiOperation({ summary: 'The incident timeline, oldest first' })
  async events(
    @Param('incidentId', idPipe) incidentId: string,
    @Req() request: AppRequest,
  ): Promise<{ data: IncidentEventDto[] }> {
    return { data: await this.incidents.events(tenantOf(request), incidentId) };
  }

  @RequirePermission('incidents.update')
  @Post(':incidentId/comments')
  @ApiOperation({ summary: 'Add a comment' })
  addComment(
    @Param('incidentId', idPipe) incidentId: string,
    @Body(new ZodValidationPipe(addCommentSchema)) body: AddCommentInput,
    @Req() request: AppRequest,
  ): Promise<IncidentEventDto> {
    return this.incidents.addComment(tenantOf(request), incidentId, body);
  }

  @RequirePermission('incidents.update')
  @Put(':incidentId/assignees')
  @ApiOperation({ summary: 'Set the incident assignees (replaces the current set)' })
  setAssignees(
    @Param('incidentId', idPipe) incidentId: string,
    @Body(new ZodValidationPipe(setAssigneesSchema)) body: SetAssigneesInput,
    @Req() request: AppRequest,
  ): Promise<IncidentDetailDto> {
    return this.incidents.setAssignees(tenantOf(request), incidentId, body);
  }
}
