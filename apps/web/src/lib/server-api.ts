import { cache } from 'react';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { loadEnv, webEnvSchema } from '@nexus/config';
import type { MeResponse, OrganizationDetailDto, ProjectDto, ServiceDto } from '@nexus/shared';

export const SESSION_COOKIE = 'nexus_session';
export const LAST_ORG_COOKIE = 'nexus_last_org';
export const OFFLINE_PATH = '/offline';

/**
 * A gateway answering for an API that is not there: what a proxy or a sleeping host returns while
 * the service behind it is down or waking up. Not an error in the API's own logic.
 */
const GATEWAY_DOWN = new Set([502, 503, 504]);

/**
 * Server-side call to the API on behalf of the current visitor. Only the session cookie is
 * forwarded. Returns the raw Response so callers can distinguish 401/404 from failures.
 * When the API cannot be reached at all (or a gateway says it is down) the visitor is sent to the
 * offline page, which explains that and recovers by itself once the API is back. Any other failure
 * throws, which the nearest error boundary renders.
 */
async function apiGet(path: string): Promise<Response> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const { API_INTERNAL_URL } = loadEnv(webEnvSchema);
  let response: Response;
  try {
    response = await fetch(new URL(`/api/v1${path}`, API_INTERNAL_URL), {
      headers: token ? { Cookie: `${SESSION_COOKIE}=${token}` } : {},
      cache: 'no-store',
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    redirect(OFFLINE_PATH);
  }
  if (GATEWAY_DOWN.has(response.status)) redirect(OFFLINE_PATH);
  return response;
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

/** Service details, or null if it does not exist in this organisation. */
export const getService = cache(
  async (orgId: string, serviceId: string): Promise<ServiceDto | null> => {
    const response = await apiGet(
      `/orgs/${encodeURIComponent(orgId)}/services/${encodeURIComponent(serviceId)}`,
    );
    if (response.status === 404 || response.status === 401) return null;
    if (!response.ok) throw new Error(`Unexpected API response (${response.status})`);
    return (await response.json()) as ServiceDto;
  },
);
