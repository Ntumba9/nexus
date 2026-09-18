import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { z } from 'zod';

export class EnvValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(
      `Invalid environment configuration:\n${issues.map((issue) => `  - ${issue}`).join('\n')}`,
    );
    this.name = 'EnvValidationError';
  }
}

/**
 * Validate `source` against `schema`. Error messages name the variable and the rule that failed
 * but never echo the offending value, because values can be secrets.
 */
export function loadEnv<S extends z.ZodType>(
  schema: S,
  source: Record<string, string | undefined> = process.env,
): z.output<S> {
  const result = schema.safeParse(source);
  if (!result.success) {
    throw new EnvValidationError(
      result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
    );
  }
  return result.data;
}

/**
 * Development convenience: load the nearest `.env` file walking up from `startDir` (so apps run
 * from their own directory still read the repo-root `.env`). Existing environment variables win.
 * Skipped in production, where configuration must come from the real environment.
 */
export function loadDotEnv(startDir: string = process.cwd()): string | undefined {
  if (process.env.NODE_ENV === 'production') return undefined;
  let dir = startDir;
  for (;;) {
    const candidate = join(dir, '.env');
    if (existsSync(candidate)) {
      process.loadEnvFile(candidate);
      return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}
