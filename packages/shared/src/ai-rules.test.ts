import { describe, expect, it } from 'vitest';
import {
  investigationOutputSchema,
  verifyInvestigation,
  type ContextSource,
  type IncidentHeader,
} from './ai';
import { analyzeWithRules } from './ai-rules';

const incident: IncidentHeader = {
  number: 7,
  title: 'Checkout is failing',
  description: '',
  severity: 'SEV2',
  status: 'OPEN',
  createdAt: '2026-09-22T10:00:00.000Z',
  serviceName: 'Checkout API',
  serviceEnvironment: 'PRODUCTION',
  serviceHealth: 'DOWN',
  tags: [],
};

const src = (
  label: string,
  kind: ContextSource['kind'],
  facts: ContextSource['facts'],
  title = label,
): ContextSource => ({
  label,
  kind,
  title,
  text: `${title} text`,
  occurredAt: null,
  refId: null,
  facts,
});

const opened = src('INC-EVT-1', 'incident_event', { actor: 'Ada Lovelace' }, 'Opened');
const deploy = (n: number, minutes: number, status = 'SUCCESS') =>
  src(`DEP-${n}`, 'deployment', {
    status,
    minutesBeforeOnset: minutes,
    environment: 'production',
    ref: 'main',
    sha7: 'abc1234',
  });
const mon = (n: number, status: 'UP' | 'DOWN', reason: string | null = 'unexpected_status') =>
  src(`MON-${n}`, 'monitoring', { status, failureReason: status === 'DOWN' ? reason : null });

const labelsOf = (sources: readonly ContextSource[]) => new Set(sources.map((s) => s.label));

function check(sources: ContextSource[]) {
  const output = analyzeWithRules({ incident, sources });
  // Always a valid answer whose every citation is a real source: verification changes nothing.
  expect(investigationOutputSchema.safeParse(output).success).toBe(true);
  const report = verifyInvestigation(output, labelsOf(sources));
  expect(report).toMatchObject({ droppedCitations: 0, droppedClaims: 0, downgradedCauses: 0 });
  return output;
}

describe('analyzeWithRules', () => {
  it('links a deployment shortly before onset, cites it and is honest about proof', () => {
    const out = check([opened, deploy(1, 12)]);
    expect(out.possibleCauses[0]).toMatchObject({
      kind: 'evidence',
      sources: ['DEP-1'],
      confidence: 'medium',
    });
    expect(out.possibleCauses[0]!.description).toMatch(/does not prove/);
    expect(out.possibleCauses[0]!.description).toContain('12 minutes');
    expect(
      out.recommendedActions.some((a) => a.risk === 'medium' && a.description.includes('DEP-1')),
    ).toBe(true);
  });

  it('rates an older deployment lower and ignores one outside the window or after onset', () => {
    expect(check([opened, deploy(1, 90)]).possibleCauses[0]!.confidence).toBe('low');
    expect(check([opened, deploy(1, 500)]).possibleCauses).toEqual([]);
    expect(check([opened, deploy(1, -5)]).possibleCauses).toEqual([]);
  });

  it('picks the deployment closest to onset', () => {
    const out = check([opened, deploy(1, 100), deploy(2, 10)]);
    expect(out.possibleCauses[0]!.sources).toEqual(['DEP-2']);
  });

  it('reports a failed deployment as a low-confidence lead', () => {
    const out = check([opened, deploy(1, 20, 'FAILURE')]);
    expect(out.possibleCauses[0]).toMatchObject({ confidence: 'low', sources: ['DEP-1'] });
  });

  it('reports repeated health-check failures with their most common reason', () => {
    const out = check([
      opened,
      mon(1, 'DOWN', 'timeout'),
      mon(2, 'DOWN', 'timeout'),
      mon(3, 'DOWN', 'connection_refused'),
    ]);
    const cause = out.possibleCauses[0]!;
    expect(cause.description).toContain('3 of the last 3');
    expect(cause.description).toContain('timeout');
    expect(cause.sources).toEqual(['MON-1', 'MON-2', 'MON-3']);
    expect(cause.confidence).toBe('medium');
  });

  it('notices recovery and lowers its confidence', () => {
    const out = check([opened, mon(1, 'DOWN'), mon(2, 'DOWN'), mon(3, 'DOWN'), mon(4, 'UP')]);
    expect(out.possibleCauses[0]!.description).toMatch(/may have recovered/);
    expect(out.possibleCauses[0]!.confidence).toBe('low');
  });

  it('does not call a single failure a pattern', () => {
    expect(check([opened, mon(1, 'DOWN'), mon(2, 'UP')]).possibleCauses).toEqual([]);
  });

  it('mentions earlier incidents on the same service', () => {
    const out = check([
      opened,
      src('INC-PREV-1', 'previous_incident', { daysAgo: 4 }, 'INC-3 Checkout timeouts'),
    ]);
    expect(out.possibleCauses[0]!.description).toContain('INC-3 Checkout timeouts');
    expect(out.possibleCauses[0]!.description).toContain('4 days ago');
  });

  it('lists matching runbooks as things to follow, low risk', () => {
    const out = check([
      opened,
      src('KB-1', 'knowledge', { title: 'Restart checkout' }, 'Restart checkout'),
    ]);
    expect(out.recommendedInvestigations.join(' ')).toContain('Restart checkout');
    expect(out.recommendedActions[0]).toMatchObject({ risk: 'low' });
    expect(out.evidence.some((e) => e.sources.includes('KB-1'))).toBe(true);
  });

  it('says plainly when nothing points at a cause, with low confidence', () => {
    const out = check([opened]);
    expect(out.possibleCauses).toEqual([]);
    expect(out.confidence).toBe('low');
    expect(out.summary).toMatch(/do not point to a single cause/);
    expect(out.recommendedInvestigations.length).toBeGreaterThan(0);
  });

  it('handles no sources at all', () => {
    const out = check([]);
    expect(out.evidence).toEqual([]);
    expect(out.confidence).toBe('low');
  });

  it('never claims more than medium, and needs two kinds of evidence for that', () => {
    expect(check([opened, deploy(1, 5)]).confidence).toBe('low'); // one kind only
    const both = check([opened, deploy(1, 5), mon(1, 'DOWN'), mon(2, 'DOWN'), mon(3, 'DOWN')]);
    expect(both.confidence).toBe('medium');
    for (const out of [both, check([opened])]) expect(out.confidence).not.toBe('high');
  });

  it('always states it is not an AI model', () => {
    expect(check([opened, deploy(1, 5)]).summary).toMatch(/rule-based analysis, not an AI model/);
  });

  it('is deterministic', () => {
    const sources = [opened, deploy(1, 12), mon(1, 'DOWN'), mon(2, 'DOWN')];
    expect(analyzeWithRules({ incident, sources })).toEqual(
      analyzeWithRules({ incident, sources }),
    );
  });

  it('stays within the answer limits with many sources', () => {
    const many = [
      opened,
      ...Array.from({ length: 30 }, (_, i) => deploy(i + 1, i)),
      ...Array.from({ length: 40 }, (_, i) => mon(i + 1, 'DOWN')),
      ...Array.from({ length: 10 }, (_, i) =>
        src(`INC-PREV-${i + 1}`, 'previous_incident', { daysAgo: i }, `Incident ${i}`),
      ),
      ...Array.from({ length: 10 }, (_, i) =>
        src(`KB-${i + 1}`, 'knowledge', { title: `Doc ${i}` }),
      ),
    ];
    const out = check(many);
    expect(out.possibleCauses.length).toBeLessThanOrEqual(5);
    expect(out.evidence.length).toBeLessThanOrEqual(10);
    expect(out.recommendedInvestigations.length).toBeLessThanOrEqual(6);
  });
});
