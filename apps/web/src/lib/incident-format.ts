import type {
  IncidentEventDto,
  IncidentSeverity,
  IncidentStatus,
  ServiceHealth,
} from '@nexus/shared';
import { INCIDENT_STATUSES, SEVERITY_LABEL } from '@nexus/shared';

export const STATUS_LABEL: Record<IncidentStatus, string> = {
  OPEN: 'Open',
  ACKNOWLEDGED: 'Acknowledged',
  INVESTIGATING: 'Investigating',
  MITIGATED: 'Mitigated',
  RESOLVED: 'Resolved',
  CANCELLED: 'Cancelled',
};

/** Button text for moving an incident *to* a status (reopening reads differently). */
export function actionLabel(from: IncidentStatus, to: IncidentStatus): string {
  if (from === 'RESOLVED' && to === 'INVESTIGATING') return 'Reopen';
  const labels: Record<IncidentStatus, string> = {
    OPEN: 'Reopen',
    ACKNOWLEDGED: 'Acknowledge',
    INVESTIGATING: 'Start investigating',
    MITIGATED: 'Mark mitigated',
    RESOLVED: 'Resolve',
    CANCELLED: 'Cancel incident',
  };
  return labels[to];
}

export const HEALTH_LABEL: Record<ServiceHealth, string> = {
  UNKNOWN: 'Not monitored',
  HEALTHY: 'Healthy',
  DEGRADED: 'Degraded',
  DOWN: 'Down',
};

const statusLabel = (value: unknown): string =>
  INCIDENT_STATUSES.includes(value as IncidentStatus)
    ? STATUS_LABEL[value as IncidentStatus]
    : String(value);

const severityLabel = (value: unknown): string =>
  SEVERITY_LABEL[value as IncidentSeverity] ?? String(value);

/** One-line, past-tense description of a timeline event ("changed status from Open to Acknowledged"). */
export function describeEvent(event: Pick<IncidentEventDto, 'type' | 'data'>): string {
  const { data } = event;
  switch (event.type) {
    case 'CREATED':
      return data.detectedBy === 'monitoring'
        ? 'opened this incident (detected by monitoring)'
        : 'opened this incident';
    case 'STATUS_CHANGED':
      return `changed status from ${statusLabel(data.from)} to ${statusLabel(data.to)}`;
    case 'SEVERITY_CHANGED':
      return `changed severity from ${severityLabel(data.from)} to ${severityLabel(data.to)}`;
    case 'ASSIGNED':
      return `assigned ${typeof data.name === 'string' ? data.name : 'a member'}`;
    case 'UNASSIGNED':
      return `unassigned ${typeof data.name === 'string' ? data.name : 'a member'}`;
    case 'UPDATED': {
      const fields = Array.isArray(data.fields) ? data.fields.map(String) : [];
      return fields.length ? `updated the ${fields.join(', ')}` : 'updated this incident';
    }
    case 'COMMENT_ADDED':
      return 'commented';
    case 'MONITORING_SIGNAL': {
      const check = typeof data.checkName === 'string' ? `“${data.checkName}”` : 'a check';
      if (data.kind === 'recovered') return `observed that ${check} recovered`;
      if (data.kind === 'went_down_again') return `observed that ${check} is failing again`;
      return `observed a monitoring change on ${check}`;
    }
    case 'DEPLOYMENT_LINKED': {
      const sha = typeof data.commitSha === 'string' ? data.commitSha.slice(0, 7) : null;
      const env = typeof data.environment === 'string' ? ` to ${data.environment}` : '';
      const what = sha ? `deployment ${sha}${env}` : 'a deployment';
      return data.relation === 'CONFIRMED'
        ? `confirmed ${what} as the cause`
        : `linked ${what} as a suspected cause`;
    }
    case 'AUTOMATION_EXECUTED': {
      const rule =
        typeof data.ruleName === 'string'
          ? `the automation rule “${data.ruleName}”`
          : 'an automation rule';
      const status =
        data.status === 'PARTIAL' ? ' (partly)' : data.status === 'FAILED' ? ' (it failed)' : '';
      return `ran ${rule}${status}`;
    }
    default:
      return 'made a change';
  }
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "just now", "5 min ago", "3 h ago", "2 d ago", then a calendar date. */
export function timeAgo(iso: string, now: number = Date.now()): string {
  const diff = now - Date.parse(iso);
  if (Number.isNaN(diff)) return '';
  if (diff < MINUTE) return 'just now';
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)} min ago`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)} h ago`;
  if (diff < 30 * DAY) return `${Math.floor(diff / DAY)} d ago`;
  return new Date(iso).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
}
