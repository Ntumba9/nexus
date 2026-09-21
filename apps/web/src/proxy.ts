import { NextResponse, type NextRequest } from 'next/server';
import { HSTS, buildCsp, newNonce } from '@/lib/csp';

/**
 * Runs before every page request: gives it a fresh nonce and a strict Content-Security-Policy, and
 * sends HSTS when the request arrived over HTTPS. The headers that never change are in next.config.ts. The proxy to the API (`/api/v1/*`) is excluded:
 * those responses are JSON or an event stream, not pages.
 */
export function proxy(request: NextRequest): NextResponse {
  const nonce = newNonce();
  const https =
    request.nextUrl.protocol === 'https:' || request.headers.get('x-forwarded-proto') === 'https';
  const csp = buildCsp({ nonce, development: process.env.NODE_ENV === 'development', https });

  // Next reads the policy from the REQUEST headers to put the nonce on its own scripts and styles.
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('Content-Security-Policy', csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('Content-Security-Policy', csp);
  if (https) response.headers.set('Strict-Transport-Security', HSTS);
  return response;
}

export const config = {
  matcher: [
    {
      // Pages only: not the API proxy, static assets or prefetches.
      source: '/((?!api/|_next/static|_next/image|favicon.ico).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
