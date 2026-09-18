# NEXUS Security Model

Status: Phase 0 design; controls are implemented and verified phase by phase. The checklist at the bottom tracks reality.

## Principles

1. Authorization is enforced server-side, per request, from session identity — never from client-supplied org or role.
2. Tenant scope is part of every query.
3. Secrets never reach the browser, logs, audit metadata, or AI prompts.
4. All external input (HTTP, webhooks, health-check responses, knowledge documents, AI output) is untrusted.
5. Fail closed, with generic client errors and detailed server logs.

## Authentication

- Passwords: argon2id; policy min 12 chars, checked against a small common-password list, max 128.
- Sessions: opaque 256-bit random token in `HttpOnly; Secure; SameSite=Lax` cookie; only the SHA-256 hash is stored; sliding expiry with absolute cap; logout revokes server-side (ADR-007).
- Rate limiting: per-IP and per-account on login/register (Redis-backed); uniform error message and comparable timing to reduce user enumeration.
- API keys: for machine access; hashed at rest, scoped permissions, shown once.

## Authorization

- Roles `OWNER > ADMIN > DEVELOPER > SUPPORT > VIEWER` map to permissions in one file. Handlers declare `@RequirePermission('incidents.resolve')`; no inline role checks.
- Guard resolves membership for the _path/session_ organisation and rejects non-members with 404 (avoid confirming existence).

## Threat model

| Threat                            | Vector                                                       | Control                                                                                                                                                             |
| --------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Credential stuffing / brute force | Login endpoint                                               | Rate limits, argon2id, lockout backoff, audit of failures                                                                                                           |
| Session theft                     | XSS, network                                                 | HttpOnly/Secure cookies, CSP, hashed tokens, revocation                                                                                                             |
| CSRF                              | Cookie auth                                                  | SameSite=Lax + required custom header / Origin check on state-changing requests                                                                                     |
| Broken authorization (IDOR)       | Guess IDs                                                    | UUIDs, tenant-scoped repositories, membership guard, cross-tenant tests                                                                                             |
| Tenant data leakage               | Missing `where`                                              | Composite FKs, repository pattern, optional RLS, vector queries filtered by org                                                                                     |
| Webhook spoofing                  | Forged GitHub events                                         | HMAC-SHA256 on raw body, constant-time compare, per-integration secret, delivery-ID idempotency, payload size cap                                                   |
| SSRF                              | User-supplied health-check URLs / webhook actions            | Resolve DNS and block private/loopback/link-local ranges (re-check at connect time), scheme allow-list, no redirects to blocked ranges, timeouts, response size cap |
| Prompt injection                  | Incident text, commit messages, KB docs, health-check bodies | See below                                                                                                                                                           |
| Sensitive data exposure           | Logs, audit, AI                                              | Redaction list, structured logging, secrets excluded from context builders                                                                                          |
| SQL injection                     | Any query                                                    | Prisma parameterisation; raw SQL only via tagged templates, reviewed                                                                                                |
| XSS                               | Markdown docs, incident comments                             | Markdown rendered with sanitisation (no raw HTML), CSP without `unsafe-inline` scripts                                                                              |
| Rate abuse / DoS                  | Any endpoint, AI endpoint                                    | Global + per-route limits, per-org AI quotas, job concurrency caps, body size limits                                                                                |
| Malicious upload                  | (No file uploads planned.)                                   | If added: type/size allow-list, no execution, separate storage                                                                                                      |
| Supply chain                      | Dependencies                                                 | Lockfile, `pnpm audit` and Dependabot in CI, minimal dependencies                                                                                                   |
| Audit tampering                   | Compromised admin/app bug                                    | DB trigger blocks UPDATE/DELETE on AuditLog                                                                                                                         |

## AI-specific controls

- Retrieval is filtered by `organization_id` derived from the authenticated user, never from the request body or prompt.
- All retrieved/external text is wrapped in delimited, ID-labelled blocks and declared as **data, not instructions** in the system prompt.
- The model has **no tools** and cannot trigger actions; output is text validated against a Zod schema and displayed only.
- Every citation must reference a source ID that exists in the sent context; unknown citations are dropped and flagged.
- Claims are typed `evidence` (with source) vs `inference`; UI labels them differently.
- Secrets/credential-shaped strings are redacted from context before sending; context size is bounded.
- Per-org rate limits and quotas; AI provider outage degrades gracefully (feature disabled, core product unaffected).

## Secrets management

Configuration via environment variables validated at startup (Zod). `.env` is git-ignored; `.env.example` has placeholders only. Integration secrets encrypted at rest with a key from env.

## Security headers

`helmet` defaults, strict CSP on web, `X-Content-Type-Options`, `Referrer-Policy`, HSTS in production, CORS restricted to configured origins.

## Implementation checklist

Nothing below is implemented yet (Phase 0). Updated as phases land.

- [ ] Password hashing and session management (Phase 2)
- [ ] RBAC permission map + guard (Phase 2)
- [ ] Tenant-scoped repositories + isolation tests (Phase 2–3)
- [ ] Webhook signature verification (Phase 5)
- [ ] SSRF protections on health checks (Phase 4)
- [ ] AI context isolation (Phase 9)
- [ ] Rate limiting, headers, audit immutability (Phase 10)

- [x] Phase 1 baseline: Helmet security headers, CORS restricted to `WEB_ORIGIN`, validated env that never echoes values, coarse client-facing health errors
