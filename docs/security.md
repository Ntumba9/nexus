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
3. **The database enforces it too (Phase 3).** Projects, services, incidents, events, comments, assignments and tags reference their parents through composite foreign keys `(organizationId, parentId)`. A cross-tenant reference is impossible for every database role, even if application code is wrong. Tests insert cross-tenant rows with raw SQL and assert PostgreSQL refuses them. Alpha cannot create an incident against Bravo's service (404, nothing created, no incident number consumed), cannot assign Bravo's users, and cannot read or change Bravo's project, service or incident through any route, including by using Bravo's ids inside Alpha's own organisation path. Foreign ids return the same 404 as ids that never existed.
4. Route params that are not UUIDs are treated as not found before touching the database.
5. **Row Level Security is not enabled, deliberately.** The application connects as the bootstrap superuser in development, CI and Compose, and superusers bypass RLS, so policies would look protective while enforcing nothing. RLS needs a separate non-superuser application role and per-transaction session variables; it is scheduled with Phase 10 hardening. See ADR-010.
6. **Append-only history (Phase 3).** The incident timeline (`IncidentEvent`) rejects UPDATE, DELETE and TRUNCATE through database triggers (tested with raw SQL), and incidents cannot be hard-deleted while they have history. Status and lifecycle timestamps are kept consistent by CHECK constraints.
7. **Untrusted content is rendered as text.** Incident titles, descriptions and comments are user-supplied; the web app renders them through React (escaped, no raw HTML), and there is no Markdown or HTML rendering of them yet.

## Error handling (implemented)

Every failure returns `{ "error": { "code", "message", "details?", "requestId" } }`. Unknown errors become a generic 500; stack traces and internal messages are logged server-side only. Malformed JSON, unknown routes and oversized bodies get the same envelope. Validation details name fields and rules, never the submitted values. A correlation id (`X-Request-Id`) is attached to every response.

## Outbound requests and SSRF (implemented for monitoring and outbound webhooks)

Health checks make HTTP requests to URLs that users supply, which is the classic server-side request forgery (SSRF) risk: someone could point a check at `http://169.254.169.254/` (cloud metadata), `http://localhost:5432/`, or an internal admin service and use NEXUS to probe or reach the network it runs in. Defence in depth, all tested:

1. **Validation when a check is saved** (`validateMonitoringUrl`): only `http`/`https`; no `user:password@`; literal IP addresses and hostnames such as `localhost`, `*.internal`, `*.local`, `*.lan` and single-label names are refused, including disguised forms (decimal `2130706433`, hex `0x7f000001`, octal `0177.0.0.1`, short `127.1`, IPv4-mapped IPv6 `::ffff:127.0.0.1`, trailing-dot `localhost.`). The same rules apply when a check is edited.
2. **Validation again at request time** (`createSafeLookup`), the layer that actually stops DNS rebinding (a name that is public when saved and resolves to an internal address later). The hostname is resolved by our own `lookup`, the request fails if **any** resolved address is non-public, and the socket is given only the validated addresses. The blocked set covers loopback, RFC 1918 private ranges, carrier-grade NAT, link-local (including the cloud metadata address), multicast, reserved and documentation ranges, NAT64, Teredo, IPv6 unique-local/link-local, and IPv4-mapped IPv6 (judged by the embedded IPv4).
3. **No redirects are followed**: a 3xx is just "unexpected status", so a public URL cannot bounce the monitor to an internal one (tested: the redirect target is never requested).
4. **The response body is never read**: the socket is destroyed as soon as headers arrive (tested with an endless body). Only the status code and response time are kept, so nothing from a target can leak into NEXUS through a check.
5. **Hard deadline** for the whole attempt including DNS and TLS (100 ms to 30 s, database-enforced), and a cap of 5 checks per service; the minimum interval is 15 s (database-enforced).
6. **Refused targets receive no request at all** (tested: the local target server records zero connections).
7. **Private targets are off by default.** `MONITORING_ALLOW_PRIVATE_NETWORKS=true` is an explicit operator opt-in for self-hosted deployments that monitor internal services, and for local development and tests. It never relaxes the scheme, credentials or redirect rules, and the worker logs a warning at startup when it is on.
8. **Secrets in URLs stay out of incidents and the UI**: query strings (which often carry tokens) are never copied into an incident description and are displayed as `?…` in the web app.

Residual risks: a public hostname can still resolve to a public address that is in turn owned by an attacker who forwards traffic (that is outside what a client can prevent); the checker identifies itself with a fixed `User-Agent` (`NEXUS-Monitor/1.0`) and sends no credentials; custom request headers and authenticated checks are not supported (and would need encrypted secret storage first).

## Automation and notifications (implemented)

1. **Tenant isolation is structural.** Rules, events, executions, notifications, destinations and audit entries all carry `organizationId` behind composite foreign keys; a notification's key points at `OrganizationMember`, so it can only exist for a member of its own organization. The worker reads the organization from the stored event, never from a job payload, and a job pointed at another organization's execution finds nothing.
2. **A rule cannot reference another tenant's things.** Webhook destinations and named recipients must belong to the rule's organization when it is saved, and are checked again when it runs (a person removed since is skipped; a disabled destination fails clearly).
3. **Nothing user-controlled is ever interpreted.** Templates are plain `{{fact}}` substitution with no expressions or HTML; values are length-limited and stripped of control characters; titles and email subjects are single-line (no header injection); emails are plain text; recipient addresses come from user records, never from rule input; notification links are in-app paths built from ids and CHECK-constrained. The UI renders all of it as text.
4. **Actions are an allow-list.** `notify`, `webhook` and `create_incident`, each with a strict schema (unknown keys dropped). AI output can never trigger actions.
5. **It cannot run away.** Per-rule cooldown and hourly cap (skips are recorded), limits on rules, actions and recipients, and no automation chains: an event an automation caused never triggers another rule.
6. **Secrets.** Outbound webhook signing secrets are AES-256-GCM encrypted, shown once, decrypted in memory only inside the worker, and never logged, stored in a result or written to the audit log. SMTP credentials are only ever passed to the mail library; errors are reduced to a short code first.
7. **Outbound webhooks** are signed with the timestamp inside the signed text (replay protection for receivers), use the monitoring SSRF protections at save time and again at send time, never follow redirects and never read the response body.
8. **The audit log** is append-only in the database, written in the same transaction as the change, and redacted before writing because nothing can be corrected afterwards.
9. **Notifications are private.** Every query is scoped by the user from the verified session, never from a parameter; another person's notification is a 404.

## Threat model

| Threat                            | Vector                                                       | Control                                                                                                                                                                                                                                                                          |
| --------------------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Credential stuffing / brute force | Login endpoint                                               | Rate limits (implemented), Argon2id (implemented), audit of failures (Phase 10)                                                                                                                                                                                                  |
| Session theft                     | XSS, network                                                 | HttpOnly/Secure cookies, hashed tokens, revocation (implemented); CSP (Phase 10)                                                                                                                                                                                                 |
| CSRF                              | Cookie auth                                                  | SameSite=Lax + Origin check on state-changing requests (implemented)                                                                                                                                                                                                             |
| Broken authorization (IDOR)       | Guess IDs                                                    | UUIDs, tenant-scoped queries, membership guard, cross-tenant tests (implemented)                                                                                                                                                                                                 |
| Tenant data leakage               | Missing `where`                                              | Composite unique keys, scoped queries, tests (implemented); optional RLS and vector queries filtered by org (later)                                                                                                                                                              |
| Webhook spoofing                  | Forged GitHub events                                         | Implemented (ADR-012): HMAC-SHA256 on the raw body, constant-time compare, per-integration secret (shown once, AES-256-GCM at rest), unauthenticated payloads never stored, per-integration delivery-ID idempotency, request size cap, per-address and bad-signature rate limits |
| SSRF                              | User-supplied health-check URLs / webhook actions            | Implemented for monitoring: validation on save and request-time DNS pinning that refuses non-public addresses, scheme allow-list, no redirects, no body read, hard deadline. The same module and the same rules guard outbound webhooks (Phase 6), including at send time.       |
| Prompt injection                  | Incident text, commit messages, KB docs, health-check bodies | See AI-specific controls                                                                                                                                                                                                                                                         |
| Sensitive data exposure           | Logs, audit, AI                                              | Uniform errors, validated env that never echoes values (implemented); redaction list, secrets excluded from context builders (later)                                                                                                                                             |
| SQL injection                     | Any query                                                    | Prisma parameterisation; raw SQL only via tagged templates (implemented)                                                                                                                                                                                                         |
| XSS                               | Markdown docs, incident comments                             | React escaping (implemented); Markdown sanitisation and CSP without `unsafe-inline` scripts (later)                                                                                                                                                                              |
| Rate abuse / DoS                  | Any endpoint, AI endpoint                                    | Auth limits (implemented); global limits, per-org AI quotas, job concurrency caps, body size limits (later; Nest's default 100 kB JSON limit applies now)                                                                                                                        |
| Malicious upload                  | (No file uploads planned.)                                   | If added: type/size allow-list, no execution, separate storage                                                                                                                                                                                                                   |
| Supply chain                      | Dependencies                                                 | Lockfile, exact version pins (implemented); `pnpm audit` and Dependabot in CI (later)                                                                                                                                                                                            |
| Audit tampering                   | Compromised admin/app bug                                    | Implemented (Phase 6): database triggers reject UPDATE, DELETE and TRUNCATE on AuditLog; entries are written inside the transaction of the change and redacted first. Wider coverage is Phase 10                                                                                 |

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
- **The audit log covers automation, outbound webhooks, GitHub integrations and incidents opened by automation** (Phase 6). Role changes, member removals and sign-in events are not yet recorded (Phase 10).
- **Real-time streams.** A stream re-checks membership, role and session every `REALTIME_HEARTBEAT_MS` (15 s by default), so a removed member or a signed-out session can keep an already-open stream for up to one heartbeat (it receives signals only, never data, and every refetch is authorized on its own). A session's idle expiry is not enforced on an open stream, only revocation and the absolute expiry. A user is limited to 10 open streams per API instance.
- **Web CSP** is not set (Phase 10). Swagger UI is served without CSP (dev tool; disable with `SWAGGER_ENABLED=false`).
- **Member add-by-email** lets holders of `users.manage` probe whether an email has an account. Replace with email invitations when email delivery exists.

## Implementation checklist

- [x] Password hashing and session management (Phase 2)
- [x] RBAC permission map and default-deny guards (Phase 2)
- [x] Tenant-scoped queries and isolation tests (Phase 2)
- [x] Composite tenant foreign keys, append-only incident timeline, lifecycle CHECKs (Phase 3)
- [ ] Row Level Security with a non-superuser application role (Phase 10; see ADR-010)
- [x] Auth rate limiting, CSRF origin check, uniform errors, request ids (Phase 2)
- [x] Validated env that never echoes values; Helmet headers; coarse health errors (Phase 1)
- [x] Webhook signature verification, encrypted secrets, replay/duplicate handling and repository check (Phase 5)
- [x] SSRF protections on health checks: URL validation, request-time DNS pinning, no redirects, no body read (Phase 4)
- [ ] AI context isolation (Phase 9)
- [x] Audit log with DB-enforced immutability, redaction before write, and coverage of automation, webhooks and integrations (Phase 6)
- [x] Automation safety valves: cooldown, hourly cap, no automation chains, per-organization limits; recipients and destinations re-checked at run time (Phase 6)
- [x] Real-time stream: signals only (no data), per-topic permission filtering, per-user notification targeting, continuous membership/session re-check, per-user connection cap (Phase 7)
- [ ] Audit coverage of the rest of the product, web CSP, OpenTelemetry (Phase 10)
