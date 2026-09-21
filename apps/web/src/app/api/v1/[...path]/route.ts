import type { NextRequest } from 'next/server';
import { loadEnv, webEnvSchema } from '@nexus/config';

/**
 * Same-origin proxy to the NestJS API. The browser only ever talks to this site, so the session
 * cookie is first-party (no CORS, no third-party-cookie problems) and the API stays on a private
 * network in production. It forwards only what the API needs and returns only safe headers.
 */
export const dynamic = 'force-dynamic';
/**
 * Serverless hosts (Vercel) end a function after a time limit, which would cut the live-update stream.
 * 60 s is within every plan's limit; the browser reconnects on its own and refetches, so the only effect
 * is a fresh stream about once a minute. It has no effect where the app runs as a long-lived server.
 */
export const maxDuration = 60;

const FORWARDED_REQUEST_HEADERS = [
  'content-type',
  'cookie',
  'origin',
  'user-agent',
  'accept',
  // GitHub webhooks are authenticated by these (see the API's webhook controller). The body is
  // forwarded byte for byte below, which the signature check requires.
  'x-hub-signature-256',
  'x-github-delivery',
  'x-github-event',
];
const RETURNED_RESPONSE_HEADERS = ['content-type', 'retry-after', 'x-request-id'];
/** The real-time stream (`GET /orgs/:orgId/events`) stays open for as long as the tab does. */
const isEventStream = (method: string, path: string[]): boolean =>
  method === 'GET' && path.length === 3 && path[0] === 'orgs' && path[2] === 'events';

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
  const stream = isEventStream(request.method, path);
  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: request.method,
      headers,
      body: hasBody ? await request.arrayBuffer() : undefined,
      redirect: 'manual',
      cache: 'no-store',
      // A stream has no overall deadline (it would be cut every 15 s); it ends when the browser
      // goes away, which aborts the upstream request too.
      signal: stream ? request.signal : AbortSignal.timeout(15_000),
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
  if (stream && upstream.ok) {
    // Keep every layer from buffering or caching the stream.
    responseHeaders.set('cache-control', 'no-cache, no-transform');
    responseHeaders.set('x-accel-buffering', 'no');
  }
  for (const cookie of upstream.headers.getSetCookie())
    responseHeaders.append('set-cookie', cookie);

  return new Response(upstream.status === 204 ? null : upstream.body, {
    status: upstream.status,
    headers: responseHeaders,
  });
}

export { proxy as GET, proxy as POST, proxy as PATCH, proxy as PUT, proxy as DELETE };
