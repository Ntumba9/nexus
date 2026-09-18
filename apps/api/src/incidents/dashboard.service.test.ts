import { describe, expect, it } from 'vitest';
import { buildTrend } from './dashboard.service';

const NOW = new Date('2026-09-19T15:30:00Z');

describe('buildTrend', () => {
  it('returns 14 zero-filled UTC days, oldest first, ending today', () => {
    const trend = buildTrend([], [], NOW);
    expect(trend).toHaveLength(14);
    expect(trend[0]!.date).toBe('2026-09-06');
    expect(trend[13]!.date).toBe('2026-09-19');
    expect(trend.every((p) => p.opened === 0 && p.resolved === 0)).toBe(true);
  });

  it('merges opened and resolved counts onto the right days', () => {
    const trend = buildTrend(
      [
        { day: '2026-09-19', count: 3n },
        { day: '2026-09-10', count: 1n },
      ],
      [{ day: '2026-09-19', count: 2n }],
      NOW,
    );
    expect(trend.find((p) => p.date === '2026-09-19')).toEqual({
      date: '2026-09-19',
      opened: 3,
      resolved: 2,
    });
    expect(trend.find((p) => p.date === '2026-09-10')).toEqual({
      date: '2026-09-10',
      opened: 1,
      resolved: 0,
    });
  });

  it('ignores rows outside the window', () => {
    const trend = buildTrend([{ day: '2025-01-01', count: 9n }], [], NOW);
    expect(trend.reduce((sum, p) => sum + p.opened, 0)).toBe(0);
  });

  it('is stable across a month boundary', () => {
    const trend = buildTrend([], [], new Date('2026-03-02T00:00:00Z'));
    expect(trend[0]!.date).toBe('2026-02-17');
    expect(trend[13]!.date).toBe('2026-03-02');
  });
});
