import type { IncidentEventType, IncidentSeverity, IncidentSummaryDto } from './incidents';
import type { ServiceHealth } from './projects';

export interface DashboardActivityDto {
  id: string;
  type: IncidentEventType;
  incidentId: string;
  incidentNumber: number;
  incidentTitle: string;
  actorName: string | null;
  data: Record<string, unknown>;
  createdAt: string;
}

export interface DashboardTrendPointDto {
  /** UTC calendar day, YYYY-MM-DD. */
  date: string;
  opened: number;
  resolved: number;
}

export interface DashboardDto {
  activeIncidents: {
    total: number;
    bySeverity: Record<IncidentSeverity, number>;
    /** Most urgent first (severity, then oldest). */
    items: IncidentSummaryDto[];
  };
  recentIncidents: IncidentSummaryDto[];
  serviceHealth: {
    total: number;
    byStatus: Record<ServiceHealth, number>;
    /** False until monitoring exists (Phase 4): statuses are then all UNKNOWN, not "healthy". */
    monitored: boolean;
  };
  /** Deployments arrive with the GitHub integration (Phase 5). */
  recentDeployments: { available: false; items: never[] };
  incidentTrend: DashboardTrendPointDto[];
  recentActivity: DashboardActivityDto[];
}
