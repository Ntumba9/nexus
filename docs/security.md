# NEXUS Security Model

Status: **Phase 2 implemented** (authentication, sessions, RBAC, tenant isolation). Sections marked "implemented" describe code that exists and is tested. The threat-model table is the full target design; the checklist at the bottom tracks what is real.

## Principles

1. Authorization is enforced server-side, per request, from session identity — never from client-supplied org or role.
2. Tenant scope is part of every query.
3. Secrets never reach the browser, logs, audit metadata, or AI prompts.
4. All external input (HTTP, webhooks, health-check responses, knowledge documents, AI output) is untrusted.
5. Fail closed, with generic client errors and detailed server logs.

## Authentication (implemented)

- **Passwords:** Argon2id via `@node-rs/argon2` (19 MiB memory, 2 iterations, 1 lane — the OWASP minimum profile), stored as a self-describing PHC string. Policy, shared by API and web: 12–128 characters, not on a small common-password list, not equal to the email. The plaintext is never stored or logged, and validation errors never echo it.
- **Sessions:** opaque 256-bit random token (`randomBytes(32)`, base64url). Only its SHA-256 is stored, so a database leak yields no usable sessions. Sliding idle expiry (default 7 days) with an absolute cap (default 30 days); sliding writes are throttled to once per 5 minutes. Sessions are revoked server-side on logout and on re-login, and are rejected if the user is disabled.
- **Cookie:** `nexus_session`, `HttpOnly`, `SameSite=Lax`, `Path=/`, `Secure` in production (or via `COOKIE_SECURE`), expiring at the absolute lifetime. JavaScript cannot read it, and it is never returned in a response body.
- **Session fixation:** no pre-authentication session exists, and every login mints a brand-new token and revokes the session the browser already held.
- **User enumeration:** login returns one identical `INVALID_CREDENTIALS` response for unknown email, wrong password and disabled account, and verifies against a dummy hash when the user does not exist so timing does not reveal accounts. **Known, accepted exception:** registration returns `EMAIL_TAKEN` for an existing address, because there is no email verification yet with which to send a neutral "check your inbox" response. It is rate limited per IP. Revisit when email delivery exists.
- **Rate limiting:** Redis fixed-window counters keyed by a SHA-256 of the identifier (no emails or IPs stored in Redis). Login is limited per account (`AUTH_RATE_LIMIT_MAX`, default 10 per 15 minutes) and per IP (three times that), so rotating either one does not help; registration is limited per IP. All attempts count. It fails **closed** with 503 if Redis is unavailable. 429 responses carry `Retry-After`.
- **CSRF:** `SameSite=Lax` plus a server-side check that every state-changing request carries an `Origin` header equal to `WEB_ORIGIN`; anything else is 403 `CSRF_ORIGIN_MISMATCH`. Login is covered too (login CSRF).
- **Same-origin API access:** the browser only talks to the Next.js site, which proxies `/api/v1/*` to the API. The cookie is therefore first-party and there is no credentialed cross-origin surface in normal use. See ADR-009.
- **API keys:** designed (hashed, scoped, shown once); not implemented until a later phase.

## Authorization (implemented)

- **One permission model:** `packages/shared/src/permissions.ts` maps each role to a set of permissions. Controllers declare `@RequirePermission('users.manage')`; nothing inspects roles directly, apart from the member policy below. The matrix is unit-tested against an independent, hand-written expectation and again over HTTP for every role.
- **Default deny:** two global guards run on every route. `SessionGuard` requires a valid session unless the route is `@Public()`. `OrgAccessGuard` handles every route containing `:orgId`: it loads the caller's membership for _that_ organisation from the database and requires the route to declare a permission. An org-scoped route with no declared permission, or a route with no access declaration at all, is denied with 403 `ROUTE_MISCONFIGURED` (tested with deliberately mis-declared routes).
- **Non-members get 404, not 403:** another tenant's organisation is indistinguishable from a nonexistent one (same status, code and message). Members lacking a permission get 403 `FORBIDDEN`, without naming the missing permission.
- **Ownership rules** (`organizations/member-policy.ts`): only an OWNER can grant, change or remove the OWNER role, and an organisation always keeps at least one OWNER. Membership changes take a row lock on the organisation inside a transaction, so concurrent demotions cannot both succeed (tested).

## Tenant isolation (implemented)

1. `organizationId` comes from the URL and is verified against the caller's membership by the guard. It is never read from a request body: an attacker-supplied `organizationId` is stripped by the Zod schemas (tested).
2. Every query on tenant-owned data is scoped by `tenant.organizationId` from the verified context. A member id from another organisation simply matches nothing, so `PATCH /orgs/A/members/<id-from-B>` returns the same 404 as an id that never existed (tested, including checking that B's data is untouched).
3. `OrganizationMember` exposes `@@unique([organizationId, id])` so later tenant-owned tables can reference it with composite foreign keys.
4. Route params that are not UUIDs are treated as not found before touching the database.
5. Postgres Row Level Security was evaluated and **deferred**: application-layer scoping is covered by cross-tenant tests, and RLS adds per-transaction session-variable plumbing that is better introduced with the first large tenant-owned tables (Phase 3). Tracked in ADR-005.

## Error handling (implemented)

Every failure returns `{ "error": { "code", "message", "details?", "requestId" } }`. Unknown errors become a generic 500; stack traces and internal messages are logged server-side only. Malformed JSON, unknown routes and oversized bodies get the same envelope. Validation details name fields and rules, never the submitted values. A correlation id (`X-Request-Id`) is attached to every response.

## Threat model

| Threat                            | Vector                                                       | Control                                                                                                                                                             |
| --------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Credential stuffing / brute force | Login endpoint                                               | Rate limits (implemented), Argon2id (implemented), audit of failures (Phase 10)                                                                                     |
| Session theft                     | XSS, network                                                 | HttpOnly/Secure cookies, hashed tokens, revocation (implemented); CSP (Phase 10)                                                                                    |
| CSRF                              | Cookie auth                                                  | SameSite=Lax + Origin check on state-changing requests (implemented)                                                                                                |
| Broken authorization (IDOR)       | Guess IDs                                                    | UUIDs, tenant-scoped queries, membership guard, cross-tenant tests (implemented)                                                                                    |
| Tenant data leakage               | Missing `where`                                              | Composite unique keys, scoped queries, tests (implemented); optional RLS and vector queries filtered by org (later)                                                 |
| Webhook spoofing                  | Forged GitHub events                                         | HMAC-SHA256 on raw body, constant-time compare, per-integration secret, delivery-ID idempotency, payload size cap (Phase 5)                                         |
| SSRF                              | User-supplied health-check URLs / webhook actions            | Resolve DNS and block private/loopback/link-local ranges (re-check at connect time), scheme allow-list, no redirects to blocked ranges, timeouts, response size cap |
| Prompt injection                  | Incident text, commit messages, KB docs, health-check bodies | See AI-specific controls                                                                                                                                            |
| Sensitive data exposure           | Logs, audit, AI                                              | Uniform errors, validated env that never echoes values (implemented); redaction list, secrets excluded from context builders (later)                                |
| SQL injection                     | Any query                                                    | Prisma parameterisation; raw SQL only via tagged templates (implemented)                                                                                            |
| XSS                               | Markdown docs, incident comments                             | React escaping (implemented); Markdown sanitisation and CSP without `unsafe-inline` scripts (later)                                                                 |
| Rate abuse / DoS                  | Any endpoint, AI endpoint                                    | Auth limits (implemented); global limits, per-org AI quotas, job concurrency caps, body size limits (later; Nest's default 100 kB JSON limit applies now)           |
| Malicious upload                  | (No file uploads planned.)                                   | If added: type/size allow-list, no execution, separate storage                                                                                                      |
| Supply chain                      | Dependencies                                                 | Lockfile, exact version pins (implemented); `pnpm audit` and Dependabot in CI (later)                                                                               |
| Audit tampering                   | Compromised admin/app bug                                    | DB trigger blocks UPDATE/DELETE on AuditLog (Phase 10)                                                                                                              |

## AI-specific controls (design; Phase 9)

- Retrieval is filtered by `organization_id` derived from the authenticated user, never from the request body or prompt.
- All retrieved/external text is wrapped in delimited, ID-labelled blocks and declared as **data, not instructions** in the system prompt.
- The model has **no tools** and cannot trigger actions; output is text validated against a Zod schema and displayed only.
- Every citation must reference a source ID that exists in the sent context; unknown citations are dropped and flagged.
- Claims are typed `evidence` (with source) vs `inference`; the UI labels them differently.
- Secrets and credential-shaped strings are redacted from context before sending; context size is bounded.
- Per-org rate limits and quotas; an AI provider outage degrades gracefully (feature disabled, core product unaffected).

## Secrets management

Configuration is via environment variables validated at startup (Zod). `.env` is git-ignored; `.env.example` has placeholders only. `ANTHROPIC_API_KEY` is optional and read only from the environment. Integration secrets will be encrypted at rest with a key from the environment.

## Security headers

API: Helmet defaults, `X-Powered-By` removed, CORS restricted to `WEB_ORIGIN`. Web: `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy`. HSTS and a strict CSP are Phase 10.

## Phase 2 security review

Reviewed against the requested areas. "Tested" means an automated test asserts it.

| Area                 | Finding                                                                                          | Status                                                      |
| -------------------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| Session fixation     | New token on every login; prior session revoked                                                  | Tested                                                      |
| Insecure cookies     | HttpOnly, SameSite=Lax, Path=/, Secure in production, hash-only storage                          | Tested (Secure is config-driven; HTTPS not exercised in CI) |
| Password handling    | Argon2id, salted, policy enforced, never returned or logged                                      | Tested                                                      |
| Authorization bypass | Default-deny guards, org-scoped permission per route, misdeclared routes denied                  | Tested                                                      |
| Tenant isolation     | Foreign org/member ids give an indistinguishable 404, no mutation, body `organizationId` ignored | Tested                                                      |
| User enumeration     | Login uniform; **registration reveals existing emails (accepted, rate limited)**                 | Tested / documented                                         |
| Rate limiting        | Per-account and per-IP, fail-closed, `Retry-After`                                               | Tested                                                      |
| Sensitive errors     | Uniform envelope, no stack, DB or permission names                                               | Tested                                                      |
| CSRF                 | Origin check on state-changing requests                                                          | Tested                                                      |

### Residual risks and follow-ups

- **Client IP behind a proxy.** The web proxy forwards `X-Forwarded-For`; the API trusts `TRUST_PROXY_HOPS` hops (0 by default, so all traffic appears to come from the proxy). With hops=1 and no real load balancer in front, a client can spoof `X-Forwarded-For` to rotate IPs; the per-account limit still holds. Production must sit behind a proxy that appends the real client address.
- **Registration enumeration** (above) until email verification exists.
- **No account lockout, password reset, MFA or "log out everywhere"** yet. `SessionService.revokeAllForUser` exists for the latter; no endpoint uses it.
- **Stale role within a request.** A role is read at the start of a request; a change made during that request is not seen until the next one. Ownership safety is unaffected because owner counts are re-read under a row lock.
- **No audit log yet** (Phase 10). Role changes and member removals are not yet recorded.
- **Web CSP** is not set (Phase 10). Swagger UI is served without CSP (dev tool; disable with `SWAGGER_ENABLED=false`).
- **Member add-by-email** lets holders of `users.manage` probe whether an email has an account. Replace with email invitations when email delivery exists.

## Implementation checklist

- [x] Password hashing and session management (Phase 2)
- [x] RBAC permission map and default-deny guards (Phase 2)
- [x] Tenant-scoped queries and isolation tests (Phase 2; RLS deferred)
- [x] Auth rate limiting, CSRF origin check, uniform errors, request ids (Phase 2)
- [x] Validated env that never echoes values; Helmet headers; coarse health errors (Phase 1)
- [ ] Webhook signature verification (Phase 5)
- [ ] SSRF protections on health checks (Phase 4)
- [ ] AI context isolation (Phase 9)
- [ ] Audit log with DB-enforced immutability, web CSP, OpenTelemetry (Phase 10)
