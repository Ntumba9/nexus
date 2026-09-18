import { cache } from 'react';
import { cookies } from 'next/headers';
import { loadEnv, webEnvSchema } from '@nexus/config';
import type { MeResponse, OrganizationDetailDto, ProjectDto } from '@nexus/shared';

export const SESSION_COOKIE = 'nexus_session';
export const LAST_ORG_COOKIE = 'nexus_last_org';

/**
 * Server-side call to the API on behalf of the current visitor. Only the session cookie is
 * forwarded. Returns the raw Response so callers can distinguish 401/404 from failures.
 * Network failures throw, which the nearest error boundary renders.
 */
async function apiGet(path: string): Promise<Response> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const { API_INTERNAL_URL } = loadEnv(webEnvSchema);
  try {
    return await fetch(new URL(`/api/v1${path}`, API_INTERNAL_URL), {
      headers: token ? { Cookie: `${SESSION_COOKIE}=${token}` } : {},
      cache: 'no-store',
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    throw new Error('The API is unreachable');
  }
}

/** The signed-in user and their memberships, or null when not signed in. Cached per request. */
export const getMe = cache(async (): Promise<MeResponse | null> => {
  const response = await apiGet('/auth/me');
  if (response.status === 401) return null;
  if (!response.ok) throw new Error(`Unexpected API response (${response.status})`);
  return (await response.json()) as MeResponse;
});

/** Organisation details, or null if it does not exist or the caller is not a member. */
export const getOrganization = cache(
  async (orgId: string): Promise<OrganizationDetailDto | null> => {
    const response = await apiGet(`/orgs/${encodeURIComponent(orgId)}`);
    if (response.status === 404 || response.status === 401) return null;
    if (!response.ok) throw new Error(`Unexpected API response (${response.status})`);
    return (await response.json()) as OrganizationDetailDto;
  },
);

/** Project details, or null if it does not exist in this organisation. */
export const getProject = cache(
  async (orgId: string, projectId: string): Promise<ProjectDto | null> => {
    const response = await apiGet(
      `/orgs/${encodeURIComponent(orgId)}/projects/${encodeURIComponent(projectId)}`,
    );
    if (response.status === 404 || response.status === 401) return null;
    if (!response.ok) throw new Error(`Unexpected API response (${response.status})`);
    return (await response.json()) as ProjectDto;
  },
);
