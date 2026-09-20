import { Body, Controller, Get, HttpCode, Inject, Param, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  startInvestigationSchema,
  type AiStatusDto,
  type InvestigationDto,
  type StartInvestigationInput,
} from '@nexus/shared';
import { ApiError } from '../common/api-error';
import type { AppRequest, TenantContext } from '../common/request-context';
import { UuidParamPipe, ZodValidationPipe } from '../common/zod.pipe';
import { RequirePermission } from '../rbac/decorators';
import { AiService } from './ai.service';

function tenantOf(request: AppRequest): TenantContext {
  if (!request.tenant) throw ApiError.forbidden('ROUTE_MISCONFIGURED', 'Access denied');
  return request.tenant;
}

const idPipe = new UuidParamPipe();

@ApiTags('ai')
@Controller('orgs/:orgId')
export class AiController {
  constructor(@Inject(AiService) private readonly ai: AiService) {}

  @RequirePermission('incidents.read')
  @Get('ai/status')
  @ApiOperation({ summary: 'Which analysis provider is configured, if any' })
  status(): AiStatusDto {
    return this.ai.status();
  }

  @RequirePermission('incidents.read')
  @Get('incidents/:incidentId/investigations')
  @ApiOperation({ summary: 'Recent investigations of an incident, newest first' })
  async list(
    @Param('incidentId', idPipe) incidentId: string,
    @Req() request: AppRequest,
  ): Promise<{ data: InvestigationDto[] }> {
    return { data: await this.ai.list(tenantOf(request), incidentId) };
  }

  @RequirePermission('incidents.update')
  @Post('incidents/:incidentId/investigations')
  @HttpCode(202)
  @ApiOperation({ summary: 'Start an AI investigation of an incident (runs in the background)' })
  start(
    @Param('incidentId', idPipe) incidentId: string,
    @Body(new ZodValidationPipe(startInvestigationSchema)) body: StartInvestigationInput,
    @Req() request: AppRequest,
  ): Promise<InvestigationDto> {
    return this.ai.start(tenantOf(request), request.id, incidentId, body);
  }
}
