import type {
  DashboardDto,
  IncidentDetailDto,
  IncidentEventDto,
  IncidentPageDto,
  MemberDto,
  MonitoringCheckDto,
  MonitoringResultPageDto,
  ProjectDto,
  ServiceDto,
} from '@nexus/shared';
import { apiFetch } from './api-client';

/** Query keys and fetchers, in one place so mutations can invalidate precisely. */
export const keys = {
  dashboard: (orgId: string) => ['dashboard', orgId] as const,
  projects: (orgId: string) => ['projects', orgId] as const,
  project: (orgId: string, id: string) => ['project', orgId, id] as const,
  services: (orgId: string, projectId?: string) => ['services', orgId, projectId ?? 'all'] as const,
  incidents: (orgId: string) => ['incidents', orgId] as const,
  incident: (orgId: string, id: string) => ['incident', orgId, id] as const,
  events: (orgId: string, id: string) => ['incident-events', orgId, id] as const,
  members: (orgId: string) => ['members', orgId] as const,
  checks: (orgId: string, serviceId: string) => ['checks', orgId, serviceId] as const,
  results: (orgId: string, checkId: string) => ['check-results', orgId, checkId] as const,
};

export const fetchers = {
  dashboard: (orgId: string) => apiFetch<DashboardDto>(`/orgs/${orgId}/dashboard`),
  projects: (orgId: string) =>
    apiFetch<{ data: ProjectDto[] }>(`/orgs/${orgId}/projects`).then((r) => r.data),
  project: (orgId: string, id: string) => apiFetch<ProjectDto>(`/orgs/${orgId}/projects/${id}`),
  services: (orgId: string, projectId?: string) =>
    apiFetch<{ data: ServiceDto[] }>(
      `/orgs/${orgId}/services${projectId ? `?projectId=${projectId}` : ''}`,
    ).then((r) => r.data),
  incident: (orgId: string, id: string) =>
    apiFetch<IncidentDetailDto>(`/orgs/${orgId}/incidents/${id}`),
  events: (orgId: string, id: string) =>
    apiFetch<{ data: IncidentEventDto[] }>(`/orgs/${orgId}/incidents/${id}/events`).then(
      (r) => r.data,
    ),
  incidentPage: (orgId: string, params: URLSearchParams) =>
    apiFetch<IncidentPageDto>(`/orgs/${orgId}/incidents?${params.toString()}`),
  members: (orgId: string) =>
    apiFetch<{ data: MemberDto[] }>(`/orgs/${orgId}/members`).then((r) => r.data),
  checks: (orgId: string, serviceId: string) =>
    apiFetch<{ data: MonitoringCheckDto[] }>(`/orgs/${orgId}/services/${serviceId}/checks`).then(
      (r) => r.data,
    ),
  results: (orgId: string, checkId: string, limit = 20) =>
    apiFetch<MonitoringResultPageDto>(`/orgs/${orgId}/checks/${checkId}/results?limit=${limit}`),
};
