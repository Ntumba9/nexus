import type { NextRequest } from 'next/server';
import { loadEnv, webEnvSchema } from '@nexus/config';

/**
 * Same-origin proxy to the NestJS API. The browser only ever talks to this site, so the session
 * cookie is first-party (no CORS, no third-party-cookie problems) and the API stays on a private
 * network in production. It forwards only what the API needs and returns only safe headers.
 */
export const dynamic = 'force-dynamic';

const FORWARDED_REQUEST_HEADERS = ['content-type', 'cookie', 'origin', 'user-agent', 'accept'];
const RETURNED_RESPONSE_HEADERS = ['content-type', 'retry-after', 'x-request-id'];

async function proxy(
  request: NextRequest,
  context: { params: Promise<{ path: string[] }> },
): Promise<Response> {
  const { path } = await context.params;
  const { API_INTERNAL_URL } = loadEnv(webEnvSchema);

  const target = new URL(`/api/v1/${path.map(encodeURIComponent).join('/')}`, API_INTERNAL_URL);
  target.search = request.nextUrl.search;

  const headers = new Headers();
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  // Lets the API's per-IP rate limiting see the real client (the API's TRUST_PROXY_HOPS must be 1).
  const forwardedFor = request.headers.get('x-forwarded-for');
  if (forwardedFor) headers.set('x-forwarded-for', forwardedFor);

  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: request.method,
      headers,
      body: hasBody ? await request.arrayBuffer() : undefined,
      redirect: 'manual',
      cache: 'no-store',
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return Response.json(
      { error: { code: 'API_UNAVAILABLE', message: 'The service is temporarily unavailable' } },
      { status: 502 },
    );
  }

  const responseHeaders = new Headers();
  for (const name of RETURNED_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) responseHeaders.set(name, value);
  }
  for (const cookie of upstream.headers.getSetCookie())
    responseHeaders.append('set-cookie', cookie);

  return new Response(upstream.status === 204 ? null : upstream.body, {
    status: upstream.status,
    headers: responseHeaders,
  });
}

export { proxy as GET, proxy as POST, proxy as PATCH, proxy as PUT, proxy as DELETE };
