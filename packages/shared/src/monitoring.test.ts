import { describe, expect, it } from 'vitest';
import {
  CHECK_LIMITS,
  aggregateServiceHealth,
  createCheckSchema,
  evaluateCheck,
  listResultsQuerySchema,
  updateCheckSchema,
  type CheckOutcome,
  type CheckState,
  type CheckTransition,
} from './index';

const START: CheckState = { health: 'UNKNOWN', consecutiveFailures: 0, consecutiveSuccesses: 0 };

/** Feed a sequence of outcomes through the state machine; returns the state and all transitions. */
function run(
  outcomes: CheckOutcome[],
  thresholds = { failureThreshold: 3, recoveryThreshold: 2 },
  from = START,
) {
  let state = from;
  const transitions: CheckTransition[] = [];
  for (const outcome of outcomes) {
    const step = evaluateCheck(state, outcome, thresholds);
    state = step.state;
    transitions.push(step.transition);
  }
  return { state, transitions };
}

describe('evaluateCheck', () => {
  it('a first success makes an unassessed check HEALTHY, with no transition', () => {
    const { state, transitions } = run(['UP']);
    expect(state.health).toBe('HEALTHY');
    expect(transitions).toEqual([null]);
  });

  it('does NOT go down on a single transient failure', () => {
    const { state, transitions } = run(['UP', 'DOWN']);
    expect(state).toMatchObject({ health: 'HEALTHY', consecutiveFailures: 1 });
    expect(transitions).toEqual([null, null]);
  });

  it('goes DOWN exactly when consecutive failures reach the threshold, once', () => {
    const { state, transitions } = run(['UP', 'DOWN', 'DOWN', 'DOWN', 'DOWN', 'DOWN']);
    expect(transitions).toEqual([null, null, null, 'WENT_DOWN', null, null]);
    expect(state).toMatchObject({ health: 'DOWN', consecutiveFailures: 5 });
  });

  it('a success in the middle resets the failure streak', () => {
    const { state, transitions } = run(['DOWN', 'DOWN', 'UP', 'DOWN', 'DOWN']);
    expect(transitions.every((t) => t === null)).toBe(true);
    expect(state).toMatchObject({ health: 'HEALTHY', consecutiveFailures: 2 });
  });

  it('a threshold of 1 means a single failure is enough (opt-in)', () => {
    const { transitions } = run(['DOWN'], { failureThreshold: 1, recoveryThreshold: 1 });
    expect(transitions).toEqual(['WENT_DOWN']);
  });

  it('a DOWN check needs the recovery threshold of consecutive successes to recover', () => {
    const down = run(['DOWN', 'DOWN', 'DOWN']).state;
    const { state, transitions } = run(['UP', 'UP'], undefined, down);
    expect(transitions).toEqual([null, 'RECOVERED']);
    expect(state).toMatchObject({ health: 'HEALTHY', consecutiveFailures: 0 });
  });

  it('a failure during recovery restarts the recovery streak (no flapping)', () => {
    const down = run(['DOWN', 'DOWN', 'DOWN']).state;
    const { state, transitions } = run(['UP', 'DOWN', 'UP', 'UP'], undefined, down);
    expect(transitions).toEqual([null, null, null, 'RECOVERED']);
    expect(state.health).toBe('HEALTHY');
  });

  it('stays DOWN, without a new WENT_DOWN, while failures continue', () => {
    const down = run(['DOWN', 'DOWN', 'DOWN']).state;
    const { transitions, state } = run(['DOWN', 'DOWN', 'DOWN'], undefined, down);
    expect(transitions).toEqual([null, null, null]);
    expect(state.health).toBe('DOWN');
  });

  it('can go DOWN again after recovering (a new outage is a new transition)', () => {
    const { transitions } = run(['DOWN', 'DOWN', 'DOWN', 'UP', 'UP', 'DOWN', 'DOWN', 'DOWN']);
    expect(transitions.filter((t) => t === 'WENT_DOWN')).toHaveLength(2);
    expect(transitions.filter((t) => t === 'RECOVERED')).toHaveLength(1);
  });

  it('never leaves an unassessed check stuck if failures stay below the threshold', () => {
    const { state } = run(['DOWN', 'DOWN']);
    expect(state.health).toBe('UNKNOWN');
  });

  it('is pure: the input state is not mutated', () => {
    const before: CheckState = {
      health: 'HEALTHY',
      consecutiveFailures: 2,
      consecutiveSuccesses: 0,
    };
    const snapshot = { ...before };
    evaluateCheck(before, 'DOWN', { failureThreshold: 3, recoveryThreshold: 2 });
    expect(before).toEqual(snapshot);
  });

  it('holds for every threshold pair: WENT_DOWN happens on failure #N and RECOVERED on success #M', () => {
    for (let failures = 1; failures <= 5; failures++) {
      for (let successes = 1; successes <= 5; successes++) {
        const t = { failureThreshold: failures, recoveryThreshold: successes };
        const down = run(Array(failures).fill('DOWN'), t);
        expect(down.transitions.at(-1), `f=${failures}`).toBe('WENT_DOWN');
        expect(down.transitions.slice(0, -1).every((x) => x === null)).toBe(true);
        const up = run(Array(successes).fill('UP'), t, down.state);
        expect(up.transitions.at(-1), `f=${failures} s=${successes}`).toBe('RECOVERED');
        expect(up.transitions.slice(0, -1).every((x) => x === null)).toBe(true);
      }
    }
  });
});

describe('aggregateServiceHealth', () => {
  it('is the worst verdict, and UNKNOWN when nothing has a verdict', () => {
    expect(aggregateServiceHealth([])).toBe('UNKNOWN');
    expect(aggregateServiceHealth(['UNKNOWN', 'UNKNOWN'])).toBe('UNKNOWN');
    expect(aggregateServiceHealth(['UNKNOWN', 'HEALTHY'])).toBe('HEALTHY');
    expect(aggregateServiceHealth(['HEALTHY', 'DOWN', 'HEALTHY'])).toBe('DOWN');
    expect(aggregateServiceHealth(['HEALTHY', 'DEGRADED'])).toBe('DEGRADED');
    expect(aggregateServiceHealth(['DOWN', 'DEGRADED'])).toBe('DOWN');
  });
});

describe('check schemas', () => {
  const base = { name: 'API health', url: 'https://example.com/health' };

  it('applies safe defaults', () => {
    expect(createCheckSchema.parse(base)).toMatchObject({
      expectedStatus: 200,
      timeoutMs: 5000,
      intervalSeconds: 60,
      failureThreshold: 3,
      recoveryThreshold: 2,
      incidentSeverity: 'SEV2',
      createIncidents: true,
      enabled: true,
    });
  });

  it('enforces every limit at both ends', () => {
    const cases: Array<[string, number, boolean]> = [
      ['timeoutMs', CHECK_LIMITS.timeoutMs.min - 1, false],
      ['timeoutMs', CHECK_LIMITS.timeoutMs.min, true],
      ['timeoutMs', CHECK_LIMITS.timeoutMs.max, true],
      ['timeoutMs', CHECK_LIMITS.timeoutMs.max + 1, false],
      ['intervalSeconds', CHECK_LIMITS.intervalSeconds.min - 1, false],
      ['intervalSeconds', CHECK_LIMITS.intervalSeconds.min, true],
      ['intervalSeconds', CHECK_LIMITS.intervalSeconds.max + 1, false],
      ['failureThreshold', 0, false],
      ['failureThreshold', 1, true],
      ['failureThreshold', 21, false],
      ['recoveryThreshold', 0, false],
      ['expectedStatus', 99, false],
      ['expectedStatus', 600, false],
      ['expectedStatus', 204, true],
    ];
    for (const [field, value, valid] of cases) {
      expect(
        createCheckSchema.safeParse({ ...base, [field]: value }).success,
        `${field}=${value}`,
      ).toBe(valid);
    }
  });

  it('rejects non-integers, strings for numbers, and unknown severities', () => {
    expect(createCheckSchema.safeParse({ ...base, intervalSeconds: 30.5 }).success).toBe(false);
    expect(createCheckSchema.safeParse({ ...base, timeoutMs: '5000' }).success).toBe(false);
    expect(createCheckSchema.safeParse({ ...base, incidentSeverity: 'SEV-1' }).success).toBe(false);
    expect(createCheckSchema.safeParse({ ...base, name: '' }).success).toBe(false);
    expect(createCheckSchema.safeParse({ ...base, url: 'x'.repeat(2049) }).success).toBe(false);
  });

  it('requires at least one field for updates', () => {
    expect(updateCheckSchema.safeParse({}).success).toBe(false);
    expect(updateCheckSchema.safeParse({ enabled: false }).success).toBe(true);
  });

  it('parses result-page queries', () => {
    expect(listResultsQuerySchema.parse({}).limit).toBe(50);
    expect(listResultsQuerySchema.safeParse({ limit: '500' }).success).toBe(false);
    expect(listResultsQuerySchema.safeParse({ before: 'yesterday' }).success).toBe(false);
    expect(listResultsQuerySchema.safeParse({ before: '2026-09-19T10:00:00.000Z' }).success).toBe(
      true,
    );
  });
});
