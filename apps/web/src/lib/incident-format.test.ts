import { INCIDENT_STATUSES, SEVERITY_LABEL, allowedTransitions } from '@nexus/shared';
import { describe, expect, it } from 'vitest';
import { STATUS_LABEL, actionLabel, describeEvent, timeAgo } from './incident-format';

describe('labels', () => {
  it('has a label for every status', () => {
    for (const status of INCIDENT_STATUSES) expect(STATUS_LABEL[status]).toBeTruthy();
  });

  it('has a distinct button label for every transition the API can offer', () => {
    for (const from of INCIDENT_STATUSES) {
      const labels = allowedTransitions(from, 'OWNER').map((to) => actionLabel(from, to));
      expect(new Set(labels).size).toBe(labels.length);
      for (const label of labels) expect(label.length).toBeGreaterThan(0);
    }
    expect(actionLabel('RESOLVED', 'INVESTIGATING')).toBe('Reopen');
    expect(actionLabel('MITIGATED', 'INVESTIGATING')).toBe('Start investigating');
  });
});

describe('describeEvent', () => {
  it('describes each event type in plain language', () => {
    expect(describeEvent({ type: 'CREATED', data: {} })).toBe('opened this incident');
    expect(
      describeEvent({ type: 'STATUS_CHANGED', data: { from: 'OPEN', to: 'ACKNOWLEDGED' } }),
    ).toBe('changed status from Open to Acknowledged');
    expect(describeEvent({ type: 'SEVERITY_CHANGED', data: { from: 'SEV3', to: 'SEV1' } })).toBe(
      `changed severity from ${SEVERITY_LABEL.SEV3} to ${SEVERITY_LABEL.SEV1}`,
    );
    expect(describeEvent({ type: 'ASSIGNED', data: { name: 'Ada' } })).toBe('assigned Ada');
    expect(describeEvent({ type: 'UNASSIGNED', data: { name: 'Ada' } })).toBe('unassigned Ada');
    expect(describeEvent({ type: 'UPDATED', data: { fields: ['title', 'tags'] } })).toBe(
      'updated the title, tags',
    );
    expect(describeEvent({ type: 'COMMENT_ADDED', data: { body: 'x' } })).toBe('commented');
  });

  it('never throws on unexpected data', () => {
    expect(describeEvent({ type: 'ASSIGNED', data: {} })).toBe('assigned a member');
    expect(describeEvent({ type: 'UPDATED', data: { fields: 'nope' } })).toBe(
      'updated this incident',
    );
    expect(describeEvent({ type: 'STATUS_CHANGED', data: { from: 'WEIRD', to: null } })).toContain(
      'WEIRD',
    );
  });
});

describe('timeAgo', () => {
  const now = Date.parse('2026-09-19T12:00:00Z');
  const ago = (ms: number) => new Date(now - ms).toISOString();

  it('formats relative times', () => {
    expect(timeAgo(ago(10_000), now)).toBe('just now');
    expect(timeAgo(ago(5 * 60_000), now)).toBe('5 min ago');
    expect(timeAgo(ago(3 * 3_600_000), now)).toBe('3 h ago');
    expect(timeAgo(ago(2 * 86_400_000), now)).toBe('2 d ago');
  });

  it('falls back to a date for old timestamps and tolerates garbage', () => {
    expect(timeAgo(ago(90 * 86_400_000), now)).toMatch(/2026/);
    expect(timeAgo('not a date', now)).toBe('');
  });
});
