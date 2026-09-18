import { z } from 'zod';

export const dependencyCheckSchema = z.object({
  status: z.enum(['up', 'down']),
  latencyMs: z.number().nonnegative(),
  /** Coarse, client-safe reason. Detailed errors are logged server-side only. */
  error: z.enum(['timeout', 'unavailable']).optional(),
});
export type DependencyCheck = z.infer<typeof dependencyCheckSchema>;

export const readinessReportSchema = z.object({
  status: z.enum(['ok', 'down']),
  checks: z.record(z.string(), dependencyCheckSchema),
  timestamp: z.string(),
});
export type ReadinessReport = z.infer<typeof readinessReportSchema>;
