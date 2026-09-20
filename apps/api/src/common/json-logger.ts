import type { LoggerService } from '@nestjs/common';
import { redactSecrets } from '@nexus/shared';
import { requestStore } from './request-store';

type Level = 'fatal' | 'error' | 'warn' | 'log' | 'debug' | 'verbose';

const RANK: Record<Level, number> = {
  verbose: 10,
  debug: 20,
  log: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};
const NAME: Record<Level, string> = {
  verbose: 'trace',
  debug: 'debug',
  log: 'info',
  warn: 'warn',
  error: 'error',
  fatal: 'fatal',
};

/** The threshold from LOG_LEVEL (`silent` mutes everything). */
function threshold(level: string): number {
  if (level === 'silent') return Infinity;
  if (level === 'trace') return RANK.verbose;
  if (level === 'info') return RANK.log;
  return RANK[level as Level] ?? RANK.log;
}

/**
 * Nest's logger as one JSON object per line, the same shape as the worker's, with the id of the
 * request being served (and who and where it is for) attached automatically. Messages are passed
 * through the secret redactor: a credential that ends up in an error message never reaches a log.
 */
export class JsonLogger implements LoggerService {
  private readonly min: number;

  constructor(
    level: string,
    private readonly base: Record<string, unknown> = { service: 'nexus-api' },
    private readonly out: (line: string, level: Level) => void = (line, level) => {
      (RANK[level] >= RANK.error ? process.stderr : process.stdout).write(`${line}\n`);
    },
  ) {
    this.min = threshold(level);
  }

  private write(level: Level, message: unknown, optional: unknown[]): void {
    if (RANK[level] < this.min) return;
    // Nest passes the context (class name) last; an error's stack may come just before it.
    const context = typeof optional.at(-1) === 'string' ? (optional.at(-1) as string) : undefined;
    const extra = optional.slice(0, context ? -1 : undefined);
    const stack = level === 'error' && typeof extra[0] === 'string' ? extra[0] : undefined;
    const scope = requestStore.getStore();
    const text =
      message instanceof Error
        ? message.message
        : typeof message === 'string'
          ? message
          : JSON.stringify(message);
    this.out(
      JSON.stringify({
        level: NAME[level],
        time: new Date().toISOString(),
        msg: redactSecrets(text),
        ...(context ? { context } : {}),
        ...(scope?.requestId ? { requestId: scope.requestId } : {}),
        ...(scope?.userId ? { userId: scope.userId } : {}),
        ...(scope?.organizationId ? { organizationId: scope.organizationId } : {}),
        ...(stack ? { stack: redactSecrets(stack).split('\n').slice(0, 8).join('\n') } : {}),
        ...this.base,
      }),
      level,
    );
  }

  log(message: unknown, ...optional: unknown[]): void {
    this.write('log', message, optional);
  }
  error(message: unknown, ...optional: unknown[]): void {
    this.write('error', message, optional);
  }
  warn(message: unknown, ...optional: unknown[]): void {
    this.write('warn', message, optional);
  }
  debug(message: unknown, ...optional: unknown[]): void {
    this.write('debug', message, optional);
  }
  verbose(message: unknown, ...optional: unknown[]): void {
    this.write('verbose', message, optional);
  }
  fatal(message: unknown, ...optional: unknown[]): void {
    this.write('fatal', message, optional);
  }
}
