import type { CookieOptions, Response } from 'express';

export const SESSION_COOKIE = 'nexus_session';

function options(secure: boolean): CookieOptions {
  return {
    httpOnly: true, // not readable by JavaScript: an XSS bug cannot steal the session token
    secure,
    sameSite: 'lax', // not sent on cross-site POSTs; top-level navigations still work
    path: '/',
  };
}

export function setSessionCookie(
  response: Response,
  token: string,
  expires: Date,
  secure: boolean,
): void {
  response.cookie(SESSION_COOKIE, token, { ...options(secure), expires });
}

export function clearSessionCookie(response: Response, secure: boolean): void {
  response.clearCookie(SESSION_COOKIE, options(secure));
}
