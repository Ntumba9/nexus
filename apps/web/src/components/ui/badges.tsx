import {
  SEVERITY_LABEL,
  type IncidentSeverity,
  type IncidentStatus,
  type ServiceHealth,
} from '@nexus/shared';
import { HEALTH_LABEL, STATUS_LABEL } from '@/lib/incident-format';
import { cn } from '@/lib/utils';

const SEVERITY_STYLE: Record<IncidentSeverity, string> = {
  SEV1: 'bg-danger/15 text-danger ring-danger/30',
  SEV2: 'bg-orange-400/15 text-orange-300 ring-orange-400/30',
  SEV3: 'bg-yellow-400/15 text-yellow-300 ring-yellow-400/30',
  SEV4: 'bg-sky-400/15 text-sky-300 ring-sky-400/30',
};

const STATUS_STYLE: Record<IncidentStatus, string> = {
  OPEN: 'bg-danger/10 text-danger ring-danger/25',
  ACKNOWLEDGED: 'bg-orange-400/10 text-orange-300 ring-orange-400/25',
  INVESTIGATING: 'bg-accent/10 text-accent ring-accent/25',
  MITIGATED: 'bg-yellow-400/10 text-yellow-300 ring-yellow-400/25',
  RESOLVED: 'bg-success/10 text-success ring-success/25',
  CANCELLED: 'bg-white/5 text-muted ring-white/10',
};

const PILL =
  'inline-flex items-center whitespace-nowrap rounded-md px-2 py-0.5 font-mono text-[11px] font-medium ring-1 ring-inset';

export function SeverityBadge({ severity }: { severity: IncidentSeverity }) {
  return <span className={cn(PILL, SEVERITY_STYLE[severity])}>{SEVERITY_LABEL[severity]}</span>;
}

export function StatusBadge({ status }: { status: IncidentStatus }) {
  return <span className={cn(PILL, STATUS_STYLE[status])}>{STATUS_LABEL[status]}</span>;
}

const HEALTH_DOT: Record<ServiceHealth, string> = {
  UNKNOWN: 'bg-white/25',
  HEALTHY: 'bg-success',
  DEGRADED: 'bg-yellow-400',
  DOWN: 'bg-danger',
};

/** Colour is never the only signal: the label is always present (visibly or for screen readers). */
export function HealthBadge({
  health,
  compact = false,
}: {
  health: ServiceHealth;
  compact?: boolean;
}) {
  return (
    <span className="inline-flex items-center gap-2 text-xs text-muted">
      <span aria-hidden className={cn('size-2 rounded-full', HEALTH_DOT[health])} />
      <span className={compact ? 'sr-only' : undefined}>{HEALTH_LABEL[health]}</span>
    </span>
  );
}

export function EnvironmentBadge({ environment }: { environment: string }) {
  return (
    <span className="rounded bg-white/5 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-muted">
      {environment.toLowerCase()}
    </span>
  );
}

export function TagList({ tags }: { tags: string[] }) {
  if (tags.length === 0) return null;
  return (
    <ul aria-label="Tags" className="flex flex-wrap gap-1">
      {tags.map((tag) => (
        <li key={tag} className="rounded bg-white/5 px-1.5 py-0.5 font-mono text-[10px] text-muted">
          {tag}
        </li>
      ))}
    </ul>
  );
}
