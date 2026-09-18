import type { ApiErrorBody } from '@nexus/shared';

/** Error thrown for any non-2xx API response, carrying the API's stable error code. */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details: { path: string; message: string }[] = [],
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * Browser-side API call. Requests go to this site's own `/api/v1/*` route (a proxy to the API), so
 * the session cookie stays first-party and is attached automatically; JavaScript never sees it.
 */
export async function apiFetch<T>(
  path: string,
  options: { method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; body?: unknown } = {},
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api/v1${path}`, {
      method: options.method ?? 'GET',
      headers: options.body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      credentials: 'same-origin',
    });
  } catch {
    throw new ApiError(0, 'NETWORK_ERROR', 'Could not reach the server. Check your connection.');
  }

  if (response.status === 204) return undefined as T;
  const payload = (await response.json().catch(() => null)) as
    (Partial<ApiErrorBody> & Record<string, unknown>) | null;

  if (!response.ok) {
    throw new ApiError(
      response.status,
      payload?.error?.code ?? 'UNKNOWN_ERROR',
      payload?.error?.message ?? 'Something went wrong',
      payload?.error?.details,
    );
  }
  return payload as T;
}

/** A user-facing sentence for an error, without leaking anything technical. */
export function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 429) return 'Too many attempts. Please wait a few minutes and try again.';
    if (error.status === 0 || error.status >= 500) {
      return 'The service is temporarily unavailable. Please try again shortly.';
    }
    return error.message;
  }
  return 'Something went wrong. Please try again.';
}
