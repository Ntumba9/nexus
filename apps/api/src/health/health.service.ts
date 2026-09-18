import { Inject, Injectable, Logger } from '@nestjs/common';
import type { DependencyCheck, ReadinessReport } from '@nexus/shared';

export interface HealthProbe {
  name: string;
  /** Resolve if the dependency is healthy, reject otherwise. */
  check(): Promise<void>;
}

export const HEALTH_PROBES = Symbol('HEALTH_PROBES');
export const PROBE_TIMEOUT_MS = 2000;

class ProbeTimeoutError extends Error {}

function withTimeout(promise: Promise<void>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ProbeTimeoutError(`timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);

  constructor(
    @Inject(HEALTH_PROBES) private readonly probes: HealthProbe[],
    private readonly timeoutMs: number = PROBE_TIMEOUT_MS,
  ) {}

  async readiness(): Promise<ReadinessReport> {
    const entries = await Promise.all(
      this.probes.map(async (probe) => [probe.name, await this.run(probe)] as const),
    );
    const checks = Object.fromEntries(entries);
    const allUp = entries.every(([, check]) => check.status === 'up');
    return { status: allUp ? 'ok' : 'down', checks, timestamp: new Date().toISOString() };
  }

  private async run(probe: HealthProbe): Promise<DependencyCheck> {
    const started = performance.now();
    try {
      await withTimeout(probe.check(), this.timeoutMs);
      return { status: 'up', latencyMs: Math.round(performance.now() - started) };
    } catch (error) {
      // Full detail stays in server logs; clients only get a coarse reason.
      this.logger.warn(
        `Health probe "${probe.name}" failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return {
        status: 'down',
        latencyMs: Math.round(performance.now() - started),
        error: error instanceof ProbeTimeoutError ? 'timeout' : 'unavailable',
      };
    }
  }
}
