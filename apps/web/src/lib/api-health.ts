import { readinessReportSchema, type ReadinessReport } from '@nexus/shared';

export type ApiStatus =
  { kind: 'report'; report: ReadinessReport } | { kind: 'unreachable'; reason: string };

/**
 * Ask the API for its readiness report. A 503 still carries a valid report (which dependency is
 * down), so the body is parsed regardless of status. Network failures and malformed responses
 * are reported as `unreachable` rather than thrown, so the UI always has something to render.
 */
export async function fetchApiStatus(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ApiStatus> {
  try {
    const response = await fetchImpl(new URL('/health/ready', baseUrl), {
      cache: 'no-store',
      signal: AbortSignal.timeout(3000),
    });
    const parsed = readinessReportSchema.safeParse(await response.json());
    if (!parsed.success) return { kind: 'unreachable', reason: 'Unexpected response from API' };
    return { kind: 'report', report: parsed.data };
  } catch {
    return { kind: 'unreachable', reason: 'Could not reach the API' };
  }
}
