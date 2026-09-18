# ADR-007: Server-side opaque sessions in HttpOnly cookies

**Status:** Accepted

## Context

First-party web app plus a separate API origin/port; also machine access via API keys.

## Problem

Secure browser auth with revocation and minimal XSS exposure.

## Options considered

1. JWT in localStorage: XSS-exposed, hard to revoke.
2. JWT in cookies: revocation still awkward, larger surface.
3. Opaque random token in HttpOnly cookie, hash stored in DB.

## Decision

Option 3 with SameSite=Lax, Secure in production, and CSRF defence via Origin check plus a required custom header. Passwords hashed with argon2id. API keys are separate, hashed, scoped credentials.

## Consequences

One DB lookup per request (cacheable in Redis). Instant revocation and logout. Web and API must share a site (same registrable domain) for cookies.
