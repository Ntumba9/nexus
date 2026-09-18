import { describe, expect, it } from 'vitest';
import {
  ACTIVE_STATUSES,
  INCIDENT_SEVERITIES,
  INCIDENT_STATUSES,
  INCIDENT_TRANSITIONS,
  SEVERITY_LABEL,
  allowedTransitions,
  canTransition,
  createIncidentSchema,
  isActiveStatus,
  listIncidentsQuerySchema,
  permissionForTransition,
  severityRank,
  transitionIncidentSchema,
  updateIncidentSchema,
  type IncidentStatus,
} from './index';

/** The complete legal set, written out by hand: any change to the state machine must edit this too. */
const LEGAL: Array<[IncidentStatus, IncidentStatus]> = [
  ['OPEN', 'ACKNOWLEDGED'],
  ['OPEN', 'CANCELLED'],
  ['ACKNOWLEDGED', 'INVESTIGATING'],
  ['ACKNOWLEDGED', 'MITIGATED'],
  ['ACKNOWLEDGED', 'RESOLVED'],
  ['ACKNOWLEDGED', 'CANCELLED'],
  ['INVESTIGATING', 'MITIGATED'],
  ['INVESTIGATING', 'RESOLVED'],
  ['INVESTIGATING', 'CANCELLED'],
  ['MITIGATED', 'INVESTIGATING'],
  ['MITIGATED', 'RESOLVED'],
  ['MITIGATED', 'CANCELLED'],
  ['RESOLVED', 'INVESTIGATING'],
];

describe('incident lifecycle', () => {
  it('permits exactly the documented transitions and no others (all 36 pairs)', () => {
    for (const from of INCIDENT_STATUSES) {
      for (const to of INCIDENT_STATUSES) {
        const expected = LEGAL.some(([a, b]) => a === from && b === to);
        expect(canTransition(from, to), `${from} → ${to}`).toBe(expected);
      }
    }
  });

  it('never allows a no-op transition', () => {
    for (const status of INCIDENT_STATUSES) expect(canTransition(status, status)).toBe(false);
  });

  it('treats CANCELLED as terminal', () => {
    expect(INCIDENT_TRANSITIONS.CANCELLED).toEqual([]);
    for (const to of INCIDENT_STATUSES) expect(canTransition('CANCELLED', to)).toBe(false);
  });

  it('only allows reopening a RESOLVED incident (into INVESTIGATING)', () => {
    expect(INCIDENT_TRANSITIONS.RESOLVED).toEqual(['INVESTIGATING']);
  });

  it('every non-terminal status can eventually reach RESOLVED or CANCELLED', () => {
    for (const start of INCIDENT_STATUSES) {
      if (start === 'CANCELLED' || start === 'RESOLVED') continue;
      const seen = new Set<IncidentStatus>([start]);
      const queue: IncidentStatus[] = [start];
      while (queue.length) {
        for (const next of INCIDENT_TRANSITIONS[queue.shift()!]) {
          if (seen.has(next)) continue;
          seen.add(next);
          queue.push(next);
        }
      }
      expect(seen.has('RESOLVED') && seen.has('CANCELLED'), start).toBe(true);
    }
  });

  it('resolving or reopening requires incidents.resolve; other moves require incidents.update', () => {
    expect(permissionForTransition('INVESTIGATING', 'RESOLVED')).toBe('incidents.resolve');
    expect(permissionForTransition('RESOLVED', 'INVESTIGATING')).toBe('incidents.resolve');
    expect(permissionForTransition('OPEN', 'ACKNOWLEDGED')).toBe('incidents.update');
    expect(permissionForTransition('INVESTIGATING', 'CANCELLED')).toBe('incidents.update');
  });

  it('allowedTransitions combines the state machine with the caller role', () => {
    expect(allowedTransitions('INVESTIGATING', 'DEVELOPER')).toEqual([
      'MITIGATED',
      'RESOLVED',
      'CANCELLED',
    ]);
    expect(allowedTransitions('INVESTIGATING', 'SUPPORT')).toEqual(['MITIGATED', 'CANCELLED']);
    expect(allowedTransitions('INVESTIGATING', 'VIEWER')).toEqual([]);
    expect(allowedTransitions('RESOLVED', 'SUPPORT')).toEqual([]);
    expect(allowedTransitions('RESOLVED', 'ADMIN')).toEqual(['INVESTIGATING']);
    expect(allowedTransitions('CANCELLED', 'OWNER')).toEqual([]);
  });

  it('classifies active statuses', () => {
    expect(ACTIVE_STATUSES).toEqual(['OPEN', 'ACKNOWLEDGED', 'INVESTIGATING', 'MITIGATED']);
    expect(isActiveStatus('RESOLVED')).toBe(false);
    expect(isActiveStatus('CANCELLED')).toBe(false);
    expect(isActiveStatus('OPEN')).toBe(true);
  });
});

describe('severity', () => {
  it('has typed labels and a most-urgent-first ordering', () => {
    expect(INCIDENT_SEVERITIES).toEqual(['SEV1', 'SEV2', 'SEV3', 'SEV4']);
    expect(SEVERITY_LABEL.SEV1).toBe('SEV-1');
    expect([...INCIDENT_SEVERITIES].sort((a, b) => severityRank(b) - severityRank(a))[0]).toBe(
      'SEV4',
    );
    expect(severityRank('SEV1')).toBeLessThan(severityRank('SEV2'));
  });

  it('rejects arbitrary severity labels', () => {
    for (const bad of ['SEV-1', 'sev1', 'CRITICAL', 'P1', '']) {
      expect(createIncidentSchema.safeParse({ title: 'x', severity: bad }).success, bad).toBe(
        false,
      );
    }
  });
});

describe('incident schemas', () => {
  it('applies defaults and normalises tags', () => {
    const parsed = createIncidentSchema.parse({
      title: '  API latency spike ',
      severity: 'SEV2',
      tags: ['Latency', 'latency', 'api'],
    });
    expect(parsed).toMatchObject({
      title: 'API latency spike',
      description: '',
      tags: ['latency', 'api'],
    });
  });

  it('bounds title, description, tags and rejects malformed service ids', () => {
    const base = { title: 'x', severity: 'SEV3' };
    expect(createIncidentSchema.safeParse({ ...base, title: '' }).success).toBe(false);
    expect(createIncidentSchema.safeParse({ ...base, title: 'x'.repeat(201) }).success).toBe(false);
    expect(
      createIncidentSchema.safeParse({ ...base, description: 'x'.repeat(10_001) }).success,
    ).toBe(false);
    expect(
      createIncidentSchema.safeParse({
        ...base,
        tags: Array(11)
          .fill('a')
          .map((t, i) => `${t}${i}`),
      }).success,
    ).toBe(false);
    expect(createIncidentSchema.safeParse({ ...base, tags: ['Bad Tag!'] }).success).toBe(false);
    expect(createIncidentSchema.safeParse({ ...base, serviceId: 'not-a-uuid' }).success).toBe(
      false,
    );
  });

  it('requires at least one field for updates and validates transitions', () => {
    expect(updateIncidentSchema.safeParse({}).success).toBe(false);
    expect(updateIncidentSchema.safeParse({ severity: 'SEV1' }).success).toBe(true);
    expect(transitionIncidentSchema.safeParse({ to: 'RESOLVED' }).success).toBe(true);
    expect(transitionIncidentSchema.safeParse({ to: 'DONE' }).success).toBe(false);
  });

  it('parses list filters from query strings', () => {
    const query = listIncidentsQuerySchema.parse({
      status: 'OPEN,INVESTIGATING',
      severity: 'SEV1',
      limit: '10',
      cursor: '42',
    });
    expect(query).toMatchObject({
      status: ['OPEN', 'INVESTIGATING'],
      severity: ['SEV1'],
      limit: 10,
      cursor: 42,
    });
    expect(listIncidentsQuerySchema.parse({}).limit).toBe(25);
    expect(listIncidentsQuerySchema.safeParse({ status: 'NOPE' }).success).toBe(false);
    expect(listIncidentsQuerySchema.safeParse({ limit: '1000' }).success).toBe(false);
  });
});
