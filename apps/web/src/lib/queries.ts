import type {
  AuditLogPageDto,
  AutomationRuleDto,
  DashboardDto,
  DeploymentDto,
  ExecutionPageDto,
  GitHubIntegrationDto,
  IncidentDeploymentsDto,
  IncidentDetailDto,
  IncidentEventDto,
  IncidentPageDto,
  KnowledgeDocumentDto,
  KnowledgeDocumentSummaryDto,
  KnowledgeSearchResultDto,
  MemberDto,
  MonitoringCheckDto,
  MonitoringResultPageDto,
  NotificationPageDto,
  OutboundWebhookDto,
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
  integrations: (orgId: string) => ['github-integrations', orgId] as const,
  rules: (orgId: string) => ['automation-rules', orgId] as const,
  executions: (orgId: string, ruleId: string) => ['automation-executions', orgId, ruleId] as const,
  webhooks: (orgId: string) => ['outbound-webhooks', orgId] as const,
  notifications: (orgId: string) => ['notifications', orgId] as const,
  unread: (orgId: string) => ['notifications-unread', orgId] as const,
  audit: (orgId: string, action?: string) => ['audit-log', orgId, action ?? 'all'] as const,
  deployments: (orgId: string, serviceId?: string) =>
    ['deployments', orgId, serviceId ?? 'all'] as const,
  incidentDeployments: (orgId: string, id: string) => ['incident-deployments', orgId, id] as const,
  knowledge: (orgId: string, tag?: string) => ['knowledge', orgId, 'list', tag ?? 'all'] as const,
  knowledgeDoc: (orgId: string, id: string) => ['knowledge', orgId, 'doc', id] as const,
  knowledgeSearch: (orgId: string, q: string) => ['knowledge-search', orgId, q] as const,
  incidentRunbooks: (orgId: string, id: string) => ['incident-runbooks', orgId, id] as const,
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
  rules: (orgId: string) =>
    apiFetch<{ data: AutomationRuleDto[] }>(`/orgs/${orgId}/automation/rules`).then((r) => r.data),
  executions: (orgId: string, ruleId: string, before?: string) =>
    apiFetch<ExecutionPageDto>(
      `/orgs/${orgId}/automation/rules/${ruleId}/executions?limit=10${before ? `&before=${encodeURIComponent(before)}` : ''}`,
    ),
  webhooks: (orgId: string) =>
    apiFetch<{ data: OutboundWebhookDto[] }>(`/orgs/${orgId}/outbound-webhooks`).then(
      (r) => r.data,
    ),
  notifications: (orgId: string, options: { limit?: number; before?: string } = {}) =>
    apiFetch<NotificationPageDto>(
      `/orgs/${orgId}/notifications?limit=${options.limit ?? 20}${options.before ? `&before=${encodeURIComponent(options.before)}` : ''}`,
    ),
  unread: (orgId: string) =>
    apiFetch<{ count: number }>(`/orgs/${orgId}/notifications/unread-count`).then((r) => r.count),
  audit: (orgId: string, action?: string, before?: string) =>
    apiFetch<AuditLogPageDto>(
      `/orgs/${orgId}/audit-logs?limit=25${action ? `&action=${encodeURIComponent(action)}` : ''}${before ? `&before=${encodeURIComponent(before)}` : ''}`,
    ),
  integrations: (orgId: string) =>
    apiFetch<{ data: GitHubIntegrationDto[] }>(`/orgs/${orgId}/integrations/github`).then(
      (r) => r.data,
    ),
  deployments: (orgId: string, serviceId?: string, limit = 25) =>
    apiFetch<{ data: DeploymentDto[] }>(
      `/orgs/${orgId}/deployments?limit=${limit}${serviceId ? `&serviceId=${serviceId}` : ''}`,
    ).then((r) => r.data),
  incidentDeployments: (orgId: string, id: string) =>
    apiFetch<IncidentDeploymentsDto>(`/orgs/${orgId}/incidents/${id}/deployments`),
  knowledge: (orgId: string, tag?: string) =>
    apiFetch<{ data: KnowledgeDocumentSummaryDto[] }>(
      `/orgs/${orgId}/knowledge${tag ? `?tag=${encodeURIComponent(tag)}` : ''}`,
    ).then((r) => r.data),
  knowledgeDoc: (orgId: string, id: string) =>
    apiFetch<KnowledgeDocumentDto>(`/orgs/${orgId}/knowledge/${id}`),
  knowledgeSearch: (orgId: string, q: string) =>
    apiFetch<KnowledgeSearchResultDto>(
      `/orgs/${orgId}/knowledge/search?q=${encodeURIComponent(q)}`,
    ),
  incidentRunbooks: (orgId: string, id: string) =>
    apiFetch<KnowledgeSearchResultDto>(`/orgs/${orgId}/knowledge/for-incident/${id}`),
  results: (orgId: string, checkId: string, limit = 20) =>
    apiFetch<MonitoringResultPageDto>(`/orgs/${orgId}/checks/${checkId}/results?limit=${limit}`),
};
