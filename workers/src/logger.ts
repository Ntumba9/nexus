export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';

const RANK: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
  silent: Infinity,
};

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

/** Minimal structured JSON logger (one object per line). Replaced by the shared logger in Phase 10. */
export function createLogger(level: LogLevel, base: Record<string, unknown> = {}): Logger {
  const write = (
    name: Exclude<LogLevel, 'silent'>,
    msg: string,
    fields?: Record<string, unknown>,
  ) => {
    if (RANK[name] < RANK[level]) return;
    const line = JSON.stringify({
      level: name,
      time: new Date().toISOString(),
      msg,
      ...base,
      ...fields,
    });
    (name === 'error' || name === 'fatal' ? process.stderr : process.stdout).write(`${line}\n`);
  };
  return {
    debug: (msg, fields) => write('debug', msg, fields),
    info: (msg, fields) => write('info', msg, fields),
    warn: (msg, fields) => write('warn', msg, fields),
    error: (msg, fields) => write('error', msg, fields),
  };
}
