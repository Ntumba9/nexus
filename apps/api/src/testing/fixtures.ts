import type { IncidentDetailDto, IncidentSeverity, ProjectDto, ServiceDto } from '@nexus/shared';
import type { TestUser } from './harness';

function expectStatus(res: { status: number; body: unknown }, status: number, what: string): void {
  if (res.status !== status) {
    throw new Error(
      `${what} failed: expected ${status}, got ${res.status} ${JSON.stringify(res.body)}`,
    );
  }
}

export async function createProject(
  user: TestUser,
  orgId: string,
  name = 'Payments API',
): Promise<ProjectDto> {
  const res = await user.client.post(`/orgs/${orgId}/projects`, {
    name,
    description: 'Test project',
  });
  expectStatus(res, 201, 'create project');
  return res.body as ProjectDto;
}

export async function createService(
  user: TestUser,
  orgId: string,
  projectId: string,
  name = 'API',
  environment: 'PRODUCTION' | 'STAGING' | 'DEVELOPMENT' = 'PRODUCTION',
): Promise<ServiceDto> {
  const res = await user.client.post(`/orgs/${orgId}/projects/${projectId}/services`, {
    name,
    environment,
  });
  expectStatus(res, 201, 'create service');
  return res.body as ServiceDto;
}

export async function createIncident(
  user: TestUser,
  orgId: string,
  overrides: {
    title?: string;
    severity?: IncidentSeverity;
    serviceId?: string | null;
    tags?: string[];
    description?: string;
  } = {},
): Promise<IncidentDetailDto> {
  const res = await user.client.post(`/orgs/${orgId}/incidents`, {
    title: 'API latency spike',
    severity: 'SEV2',
    ...overrides,
  });
  expectStatus(res, 201, 'create incident');
  return res.body as IncidentDetailDto;
}

/** Walk an incident to a status through legal transitions, using a user who may perform them. */
export async function moveTo(
  user: TestUser,
  orgId: string,
  incidentId: string,
  path: Array<'ACKNOWLEDGED' | 'INVESTIGATING' | 'MITIGATED' | 'RESOLVED' | 'CANCELLED'>,
): Promise<IncidentDetailDto> {
  let last: IncidentDetailDto | undefined;
  for (const to of path) {
    const res = await user.client.post(`/orgs/${orgId}/incidents/${incidentId}/transitions`, {
      to,
    });
    expectStatus(res, 200, `transition to ${to}`);
    last = res.body as IncidentDetailDto;
  }
  return last!;
}
