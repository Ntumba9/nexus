import { Controller, Get, Inject, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { DashboardDto } from '@nexus/shared';
import { ApiError } from '../common/api-error';
import type { AppRequest } from '../common/request-context';
import { RequirePermission } from '../rbac/decorators';
import { DashboardService } from './dashboard.service';

@ApiTags('dashboard')
@Controller('orgs/:orgId/dashboard')
export class DashboardController {
  constructor(@Inject(DashboardService) private readonly dashboard: DashboardService) {}

  @RequirePermission('incidents.read')
  @Get()
  @ApiOperation({ summary: 'Overview: active incidents, service health, trend, recent activity' })
  get(@Req() request: AppRequest): Promise<DashboardDto> {
    if (!request.tenant) throw ApiError.forbidden('ROUTE_MISCONFIGURED', 'Access denied');
    return this.dashboard.get(request.tenant);
  }
}
