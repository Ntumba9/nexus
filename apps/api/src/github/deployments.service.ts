import { Inject, Injectable } from '@nestjs/common';
import type { Prisma, PrismaClient } from '@nexus/database';
import {
  DEPLOYMENT_SUGGESTION_WINDOW_MINUTES,
  type DeploymentDto,
  type DeploymentStatus,
  type IncidentDeploymentDto,
  type IncidentDeploymentsDto,
  type LinkDeploymentInput,
} from '@nexus/shared';
import { ApiError } from '../common/api-error';
import type { TenantContext } from '../common/request-context';
import { PRISMA } from '../infrastructure/tokens';

const deploymentSelect = {
  id: true,
  projectId: true,
  serviceId: true,
  environment: true,
  ref: true,
  commitSha: true,
  status: true,
  author: true,
  description: true,
  startedAt: true,
  deployedAt: true,
  integration: { select: { repoFullName: true } },
} satisfies Prisma.DeploymentSelect;

type DeploymentRow = Prisma.DeploymentGetPayload<{ select: typeof deploymentSelect }>;

function toDto(row: DeploymentRow): DeploymentDto {
  return {
    id: row.id,
    projectId: row.projectId,
    serviceId: row.serviceId,
    repoFullName: row.integration.repoFullName,
    environment: row.environment,
    ref: row.ref,
    commitSha: row.commitSha,
    status: row.status as DeploymentStatus,
    author: row.author,
    description: row.description,
    startedAt: row.startedAt.toISOString(),
    deployedAt: row.deployedAt?.toISOString() ?? null,
  };
}

const MINUTE_MS = 60_000;
const SUGGESTION_LIMIT = 5;

@Injectable()
export class DeploymentsService {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async list(
    tenant: TenantContext,
    filter: { serviceId?: string; limit: number },
  ): Promise<DeploymentDto[]> {
    const rows = await this.prisma.deployment.findMany({
      where: {
        organizationId: tenant.organizationId,
        ...(filter.serviceId ? { serviceId: filter.serviceId } : {}),
      },
      orderBy: { startedAt: 'desc' },
      take: filter.limit,
      select: deploymentSelect,
    });
    return rows.map(toDto);
  }

  async forIncident(tenant: TenantContext, incidentId: string): Promise<IncidentDeploymentsDto> {
    const incident = await this.prisma.incident.findFirst({
      where: { id: incidentId, organizationId: tenant.organizationId },
      select: { id: true, serviceId: true, createdAt: true },
    });
    if (!incident) throw ApiError.notFound('Incident not found');

    const links = await this.prisma.incidentDeployment.findMany({
      where: { organizationId: tenant.organizationId, incidentId },
      orderBy: { createdAt: 'desc' },
      select: {
        relation: true,
        linkedById: true,
        createdAt: true,
        deployment: { select: deploymentSelect },
      },
    });
    const linked: IncidentDeploymentDto[] = links.map((link) => ({
      deployment: toDto(link.deployment),
      relation: link.relation,
      linkedById: link.linkedById,
      linkedAt: link.createdAt.toISOString(),
    }));

    let suggested: DeploymentDto[] = [];
    if (incident.serviceId) {
      const windowStart = new Date(
        incident.createdAt.getTime() - DEPLOYMENT_SUGGESTION_WINDOW_MINUTES * MINUTE_MS,
      );
      const rows = await this.prisma.deployment.findMany({
        where: {
          organizationId: tenant.organizationId,
          serviceId: incident.serviceId,
          status: 'SUCCESS',
          deployedAt: { gte: windowStart, lte: incident.createdAt },
          id: { notIn: links.map((link) => link.deployment.id) },
        },
        orderBy: { deployedAt: 'desc' },
        take: SUGGESTION_LIMIT,
        select: deploymentSelect,
      });
      suggested = rows.map(toDto);
    }
    return { linked, suggested };
  }

  /** Links a deployment to an incident and records it on the incident timeline, atomically. */
  async link(
    tenant: TenantContext,
    incidentId: string,
    input: LinkDeploymentInput,
  ): Promise<IncidentDeploymentDto> {
    const orgId = tenant.organizationId;
    try {
      return await this.prisma.$transaction(async (tx) => {
        const incident = await tx.incident.findFirst({
          where: { id: incidentId, organizationId: orgId },
          select: { id: true },
        });
        if (!incident) throw ApiError.notFound('Incident not found');
        const deployment = await tx.deployment.findFirst({
          where: { id: input.deploymentId, organizationId: orgId },
          select: deploymentSelect,
        });
        if (!deployment) throw ApiError.notFound('Deployment not found');

        const link = await tx.incidentDeployment.create({
          data: {
            organizationId: orgId,
            incidentId,
            deploymentId: deployment.id,
            relation: input.relation,
            linkedById: tenant.userId,
          },
          select: { relation: true, linkedById: true, createdAt: true },
        });
        await tx.incidentEvent.create({
          data: {
            organizationId: orgId,
            incidentId,
            type: 'DEPLOYMENT_LINKED',
            actorType: 'USER',
            actorId: tenant.userId,
            data: {
              deploymentId: deployment.id,
              commitSha: deployment.commitSha,
              environment: deployment.environment,
              repo: deployment.integration.repoFullName,
              relation: input.relation,
            },
          },
        });
        return {
          deployment: toDto(deployment),
          relation: link.relation,
          linkedById: link.linkedById,
          linkedAt: link.createdAt.toISOString(),
        };
      });
    } catch (error) {
      if ((error as { code?: string }).code === 'P2002') {
        throw ApiError.conflict(
          'ALREADY_LINKED',
          'This deployment is already linked to the incident',
        );
      }
      throw error;
    }
  }
}
