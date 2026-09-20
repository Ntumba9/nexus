import type {
  Confidence,
  ContextSource,
  IncidentHeader,
  InvestigationOutput,
  SourceKind,
} from './ai';

/**
 * The built-in, rule-based analysis: the free, offline, no-key way to run an investigation. It is NOT
 * a language model and says so. It reads the structured facts the context assembler took from the
 * database and reports what they show: a deployment shortly before the incident, health checks that
 * keep failing, earlier incidents on the same service, and runbooks that match. Every statement cites
 * the source it came from, and it never claims more than those sources support (its confidence
 * never exceeds "medium").
 */

export const RULES_ANALYSIS_LABEL = 'Built-in rule-based analysis (no AI model)';

type Cause = InvestigationOutput['possibleCauses'][number];

const fact = (source: ContextSource, key: string): string | number | boolean | null =>
  source.facts[key] ?? null;
const num = (source: ContextSource, key: string): number | null => {
  const value = fact(source, key);
  return typeof value === 'number' ? value : null;
};
const str = (source: ContextSource, key: string): string | null => {
  const value = fact(source, key);
  return typeof value === 'string' ? value : null;
};
const ofKind = (sources: readonly ContextSource[], kind: SourceKind) =>
  sources.filter((source) => source.kind === kind);

/** A deployment this close before the incident is worth looking at. */
export const DEPLOYMENT_WINDOW_MINUTES = 120;
/** Within this, the timing is suggestive rather than merely possible. */
const CLOSE_MINUTES = 30;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const minutesLabel = (m: number) =>
  m < 1
    ? 'less than a minute'
    : m < 60
      ? plural(Math.round(m), 'minute')
      : `${(m / 60).toFixed(1)} hours`;

export function analyzeWithRules(input: {
  incident: IncidentHeader;
  sources: readonly ContextSource[];
}): InvestigationOutput {
  const { incident, sources } = input;
  const causes: Cause[] = [];
  const evidence: InvestigationOutput['evidence'] = [];
  const investigations: string[] = [];
  const actions: InvestigationOutput['recommendedActions'] = [];
  const groundedKinds = new Set<SourceKind>();

  // 1. Deployments shortly before the incident opened.
  const deployments = ofKind(sources, 'deployment')
    .map((source) => ({
      source,
      minutes: num(source, 'minutesBeforeOnset'),
      status: str(source, 'status'),
    }))
    .filter((d) => d.minutes !== null && d.minutes >= 0 && d.minutes <= DEPLOYMENT_WINDOW_MINUTES)
    .sort((a, b) => a.minutes! - b.minutes!);
  const succeeded = deployments.find((d) => d.status === 'SUCCESS');
  const failed = deployments.find((d) => d.status === 'FAILURE');
  if (succeeded) {
    const s = succeeded.source;
    const where = [str(s, 'environment'), str(s, 'ref')].filter(Boolean).join(', ');
    const sha = str(s, 'sha7');
    const what = `A deployment${where ? ` (${where}${sha ? ` @ ${sha}` : ''})` : ''}`;
    causes.push({
      description: `${what} succeeded ${minutesLabel(succeeded.minutes!)} before this incident opened. A recent change is a common trigger; the timing alone does not prove it is the cause.`,
      kind: 'evidence',
      sources: [s.label],
      confidence: succeeded.minutes! <= CLOSE_MINUTES ? 'medium' : 'low',
    });
    evidence.push({
      statement: `${what} succeeded ${minutesLabel(succeeded.minutes!)} before the incident opened.`,
      sources: [s.label],
    });
    groundedKinds.add('deployment');
    investigations.push(
      `Compare error rates and latency before and after ${sha ? `commit ${sha}` : 'that deployment'} (${s.label}).`,
      `Review what changed in ${sha ? `commit ${sha}` : 'that deployment'} for anything touching the failing path.`,
    );
    actions.push({
      description: `If errors began right after ${s.label}, consider rolling that deployment back. Confirm first that the timing matches.`,
      risk: 'medium',
    });
  }
  if (failed) {
    const s = failed.source;
    evidence.push({
      statement: `A deployment failed ${minutesLabel(failed.minutes!)} before the incident opened.`,
      sources: [s.label],
    });
    causes.push({
      description: `A deployment failed ${minutesLabel(failed.minutes!)} before this incident opened; a partial or failed rollout can leave a service unhealthy.`,
      kind: 'evidence',
      sources: [s.label],
      confidence: 'low',
    });
    groundedKinds.add('deployment');
    investigations.push(
      `Check whether the failed deployment (${s.label}) left the service half-rolled-out.`,
    );
  }

  // 2. Health checks that keep failing.
  const results = ofKind(sources, 'monitoring');
  const down = results.filter((r) => str(r, 'status') === 'DOWN');
  if (down.length >= 2) {
    const reasons = new Map<string, number>();
    for (const r of down) {
      const reason = str(r, 'failureReason') ?? 'unknown';
      reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
    }
    const [topReason] = [...reasons.entries()].sort((a, b) => b[1] - a[1])[0]!;
    const cite = down.slice(-3).map((r) => r.label);
    const latest = results[results.length - 1];
    const recovered = latest ? str(latest, 'status') === 'UP' : false;
    causes.push({
      description: `Health checks failed ${down.length} of the last ${results.length} times, most often with "${topReason.replace(/_/g, ' ')}"${recovered ? ' (the latest check passed, so it may have recovered)' : ''}.`,
      kind: 'evidence',
      sources: cite,
      confidence: down.length >= 3 && !recovered ? 'medium' : 'low',
    });
    evidence.push({
      statement: `${down.length} of the last ${results.length} health checks failed; the most common reason was "${topReason.replace(/_/g, ' ')}".`,
      sources: cite,
    });
    groundedKinds.add('monitoring');
    investigations.push(
      `Look at the service's own logs for "${topReason.replace(/_/g, ' ')}" around the first failing check (${down[0]!.label}).`,
    );
  }

  // 3. Earlier incidents on the same service.
  const previous = ofKind(sources, 'previous_incident');
  if (previous.length > 0) {
    const nearest = previous[0]!;
    const days = num(nearest, 'daysAgo');
    causes.push({
      description: `This service has had ${plural(previous.length, 'earlier incident')} recently; the latest was ${nearest.title}${days !== null ? ` (${plural(Math.round(days), 'day')} ago)` : ''}. A recurring problem may share a root cause.`,
      kind: 'evidence',
      sources: previous.slice(0, 3).map((p) => p.label),
      confidence: 'low',
    });
    evidence.push({
      statement: `${plural(previous.length, 'earlier incident')} on this service: ${previous
        .slice(0, 3)
        .map((p) => p.title)
        .join('; ')}.`,
      sources: previous.slice(0, 3).map((p) => p.label),
    });
    groundedKinds.add('previous_incident');
    investigations.push(`Read how ${nearest.label} was resolved; the same fix may apply.`);
  }

  // 4. Runbooks that match.
  const runbooks = ofKind(sources, 'knowledge').slice(0, 3);
  for (const rb of runbooks) {
    investigations.push(`Follow the runbook "${str(rb, 'title') ?? rb.title}" (${rb.label}).`);
    actions.push({
      description: `Work through the steps of "${str(rb, 'title') ?? rb.title}" (${rb.label}) and stop if any step does not match what you see.`,
      risk: 'low',
    });
  }
  if (runbooks.length > 0) {
    groundedKinds.add('knowledge');
    // Cited, so a person can open the runbook text the analysis matched.
    evidence.push({
      statement: `${plural(runbooks.length, 'runbook')} in the knowledge base ${runbooks.length === 1 ? 'matches' : 'match'} this incident: ${runbooks
        .map((rb) => `“${str(rb, 'title') ?? rb.title}”`)
        .join(', ')}.`,
      sources: runbooks.map((rb) => rb.label),
    });
  }

  // The incident's own record always grounds the summary.
  const first = ofKind(sources, 'incident_event')[0];
  if (first) {
    evidence.unshift({
      statement: `The incident was opened${str(first, 'actor') ? ` by ${str(first, 'actor')}` : ''} as ${incident.severity} and is ${incident.status.toLowerCase().replace(/_/g, ' ')}.`,
      sources: [first.label],
    });
  }

  if (causes.length === 0) {
    investigations.push(
      'No recent deployment, failing health check or earlier incident points at a cause. Check the service’s logs and recent configuration changes.',
      'Ask whether anything outside NEXUS changed (infrastructure, a dependency, traffic).',
    );
  }

  const strongest: Confidence = causes.some((c) => c.confidence === 'medium') ? 'medium' : 'low';
  const confidence: Confidence =
    groundedKinds.size >= 2 && strongest === 'medium' ? 'medium' : 'low';

  const lead = causes[0];
  const service = incident.serviceName ? ` on ${incident.serviceName}` : '';
  const summary =
    `INC-${incident.number} “${incident.title}” (${incident.severity}, ${incident.status.toLowerCase().replace(/_/g, ' ')})${service}. ` +
    (lead
      ? `Most likely lead: ${lead.description} `
      : 'The available sources do not point to a single cause. ') +
    'This is a rule-based analysis, not an AI model: it links the incident to recent deployments, failing health checks and earlier incidents, and lists matching runbooks.';

  return {
    summary: summary.slice(0, 1500),
    possibleCauses: causes.slice(0, 5),
    evidence: evidence.slice(0, 10),
    recommendedInvestigations: [...new Set(investigations)].slice(0, 6),
    recommendedActions: actions.slice(0, 6),
    confidence,
  };
}
