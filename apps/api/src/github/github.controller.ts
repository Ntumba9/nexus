import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  createGitHubIntegrationSchema,
  linkDeploymentSchema,
  type CreateGitHubIntegrationInput,
  type CreatedGitHubIntegrationDto,
  type DeploymentDto,
  type GitHubIntegrationDto,
  type IncidentDeploymentDto,
  type IncidentDeploymentsDto,
  type LinkDeploymentInput,
} from '@nexus/shared';
import { z } from 'zod';
import { ApiError } from '../common/api-error';
import type { AppRequest, TenantContext } from '../common/request-context';
import { UuidParamPipe, ZodValidationPipe } from '../common/zod.pipe';
import { RequirePermission } from '../rbac/decorators';
import { DeploymentsService } from './deployments.service';
import { GitHubIntegrationsService } from './github-integrations.service';

function tenantOf(request: AppRequest): TenantContext {
  if (!request.tenant) throw ApiError.forbidden('ROUTE_MISCONFIGURED', 'Access denied');
  return request.tenant;
}

const idPipe = new UuidParamPipe();

const listDeploymentsQuerySchema = z.object({
  serviceId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

@ApiTags('github')
@Controller('orgs/:orgId')
export class GitHubController {
  constructor(
    @Inject(GitHubIntegrationsService) private readonly integrations: GitHubIntegrationsService,
    @Inject(DeploymentsService) private readonly deployments: DeploymentsService,
  ) {}

  @RequirePermission('projects.read')
  @Get('integrations/github')
  @ApiOperation({ summary: "The organization's active GitHub integrations (never their secrets)" })
  async listIntegrations(@Req() request: AppRequest): Promise<{ data: GitHubIntegrationDto[] }> {
    return { data: await this.integrations.list(tenantOf(request)) };
  }

  @RequirePermission('integrations.manage')
  @Post('integrations/github')
  @ApiOperation({ summary: 'Connect a repository. The webhook secret is returned once.' })
  createIntegration(
    @Body(new ZodValidationPipe(createGitHubIntegrationSchema)) body: CreateGitHubIntegrationInput,
    @Req() request: AppRequest,
  ): Promise<CreatedGitHubIntegrationDto> {
    return this.integrations.create(tenantOf(request), request.id, body);
  }

  @RequirePermission('integrations.manage')
  @Delete('integrations/github/:integrationId')
  @HttpCode(204)
  @ApiOperation({ summary: 'Disable an integration (history is kept)' })
  async disableIntegration(
    @Param('integrationId', idPipe) integrationId: string,
    @Req() request: AppRequest,
  ): Promise<void> {
    await this.integrations.disable(tenantOf(request), request.id, integrationId);
  }

  @RequirePermission('projects.read')
  @Get('deployments')
  @ApiOperation({ summary: 'Recent deployments, newest first' })
  async listDeployments(
    @Query(new ZodValidationPipe(listDeploymentsQuerySchema))
    query: z.infer<typeof listDeploymentsQuerySchema>,
    @Req() request: AppRequest,
  ): Promise<{ data: DeploymentDto[] }> {
    return { data: await this.deployments.list(tenantOf(request), query) };
  }

  @RequirePermission('incidents.read')
  @Get('incidents/:incidentId/deployments')
  @ApiOperation({ summary: 'Deployments linked to an incident, plus suggestions' })
  forIncident(
    @Param('incidentId', idPipe) incidentId: string,
    @Req() request: AppRequest,
  ): Promise<IncidentDeploymentsDto> {
    return this.deployments.forIncident(tenantOf(request), incidentId);
  }

  @RequirePermission('incidents.update')
  @Post('incidents/:incidentId/deployments')
  @ApiOperation({ summary: 'Link a deployment to an incident' })
  link(
    @Param('incidentId', idPipe) incidentId: string,
    @Body(new ZodValidationPipe(linkDeploymentSchema)) body: LinkDeploymentInput,
    @Req() request: AppRequest,
  ): Promise<IncidentDeploymentDto> {
    return this.deployments.link(tenantOf(request), incidentId, body);
  }
}
