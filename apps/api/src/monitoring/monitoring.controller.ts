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
  createCheckSchema,
  listResultsQuerySchema,
  updateCheckSchema,
  type CreateCheckInput,
  type ListResultsQuery,
  type MonitoringCheckDto,
  type MonitoringResultPageDto,
  type UpdateCheckInput,
} from '@nexus/shared';
import { ApiError } from '../common/api-error';
import type { AppRequest, TenantContext } from '../common/request-context';
import { UuidParamPipe, ZodValidationPipe } from '../common/zod.pipe';
import { RequirePermission } from '../rbac/decorators';
import { MonitoringService } from './monitoring.service';

function tenantOf(request: AppRequest): TenantContext {
  if (!request.tenant) throw ApiError.forbidden('ROUTE_MISCONFIGURED', 'Access denied');
  return request.tenant;
}

const idPipe = new UuidParamPipe();

@ApiTags('monitoring')
@Controller('orgs/:orgId')
export class MonitoringController {
  constructor(@Inject(MonitoringService) private readonly monitoring: MonitoringService) {}

  @RequirePermission('projects.read')
  @Get('services/:serviceId/checks')
  @ApiOperation({ summary: "A service's monitoring checks" })
  async list(
    @Param('serviceId', idPipe) serviceId: string,
    @Req() request: AppRequest,
  ): Promise<{ data: MonitoringCheckDto[] }> {
    return { data: await this.monitoring.list(tenantOf(request), serviceId) };
  }

  @RequirePermission('services.manage')
  @Post('services/:serviceId/checks')
  @ApiOperation({ summary: 'Add an HTTP health check to a service' })
  create(
    @Param('serviceId', idPipe) serviceId: string,
    @Body(new ZodValidationPipe(createCheckSchema)) body: CreateCheckInput,
    @Req() request: AppRequest,
  ): Promise<MonitoringCheckDto> {
    return this.monitoring.create(tenantOf(request), serviceId, body);
  }

  @RequirePermission('projects.read')
  @Get('checks/:checkId')
  @ApiOperation({ summary: 'A check with its current state' })
  get(
    @Param('checkId', idPipe) checkId: string,
    @Req() request: AppRequest,
  ): Promise<MonitoringCheckDto> {
    return this.monitoring.get(tenantOf(request), checkId);
  }

  @RequirePermission('services.manage')
  @Patch('checks/:checkId')
  @ApiOperation({ summary: 'Change a check (URL, thresholds, enabled…)' })
  update(
    @Param('checkId', idPipe) checkId: string,
    @Body(new ZodValidationPipe(updateCheckSchema)) body: UpdateCheckInput,
    @Req() request: AppRequest,
  ): Promise<MonitoringCheckDto> {
    return this.monitoring.update(tenantOf(request), checkId, body);
  }

  @RequirePermission('services.manage')
  @Delete('checks/:checkId')
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete a check and its results' })
  remove(@Param('checkId', idPipe) checkId: string, @Req() request: AppRequest): Promise<void> {
    return this.monitoring.remove(tenantOf(request), checkId);
  }

  @RequirePermission('services.manage')
  @Post('checks/:checkId/run')
  @HttpCode(202)
  @ApiOperation({ summary: 'Run a check as soon as possible (asynchronous)' })
  async run(
    @Param('checkId', idPipe) checkId: string,
    @Req() request: AppRequest,
  ): Promise<{ status: 'scheduled' }> {
    await this.monitoring.runNow(tenantOf(request), checkId);
    return { status: 'scheduled' };
  }

  @RequirePermission('projects.read')
  @Get('checks/:checkId/results')
  @ApiOperation({ summary: 'Recent results, newest first' })
  results(
    @Param('checkId', idPipe) checkId: string,
    @Query(new ZodValidationPipe(listResultsQuerySchema)) query: ListResultsQuery,
    @Req() request: AppRequest,
  ): Promise<MonitoringResultPageDto> {
    return this.monitoring.results(tenantOf(request), checkId, query);
  }
}
