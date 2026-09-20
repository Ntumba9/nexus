/**
 * The web app's security headers (Phase 10, ADR-017). Pure functions, so the exact policy is unit
 * tested and reviewed in one place; `src/proxy.ts` applies them to every page request.
 *
 * The policy is strict: scripts and styles run only if they carry this request's random nonce (Next
 * adds it to its own tags), nothing may be framed, plugins are off, and the page may talk only to its
 * own origin (the API is reached through the same-origin proxy, and so is the live stream).
 */

export interface CspOptions {
  nonce: string;
  /** `next dev` needs eval for its debugging; production never does. */
  development: boolean;
  /** Only tell the browser to upgrade requests when it really is on HTTPS (not on http://localhost). */
  https: boolean;
}

export function buildCsp({ nonce, development, https }: CspOptions): string {
  const directives = [
    `default-src 'self'`,
    // 'strict-dynamic' lets a nonced script load the chunks it needs, and makes 'self' irrelevant to
    // modern browsers, which is the point: an injected <script src> without the nonce is refused.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${development ? " 'unsafe-eval'" : ''}`,
    `style-src 'self' 'nonce-${nonce}'${development ? " 'unsafe-inline'" : ''}`,
    `img-src 'self' blob: data:`,
    `font-src 'self'`,
    `connect-src 'self'`,
    `object-src 'none'`,
    `base-uri 'self'`,
    `form-action 'self'`,
    `frame-ancestors 'none'`,
    `manifest-src 'self'`,
    ...(https ? ['upgrade-insecure-requests'] : []),
  ];
  return directives.join('; ');
}

/** Two years, the value browsers require for the HSTS preload list. Only ever sent over HTTPS. */
export const HSTS = 'max-age=63072000; includeSubDomains';

/** A fresh, unguessable nonce for one request. */
export function newNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Headers that are the same for every response. */
export const STATIC_SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
};
