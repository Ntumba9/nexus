# NEXUS Architecture

Status: Phase 0 design. Sections marked _(planned)_ describe the target design; they are not yet implemented.

## 1. System overview

```text
                 ┌────────────┐   REST /api/v1 + SSE    ┌──────────────┐
   Browser ────► │ apps/web   │ ──────────────────────► │  apps/api    │
                 │ Next.js    │  (cookie session)       │  NestJS      │
                 └────────────┘                         └──┬───────┬───┘
                                                           │       │ enqueue
                                        Prisma (tenant-    │       ▼
                                        scoped queries)    │   ┌───────┐
                                                           ▼   │ Redis │
                                                    ┌──────────┴┐  │BullMQ │
                                                    │ PostgreSQL│  └───┬───┘
                                                    │ + pgvector│      │ consume
                                                    └─────▲─────┘      ▼
                                                          │       ┌─────────┐
                                                          └────── │ workers │──► HTTP checks, GitHub API,
                                                                  └─────────┘    Anthropic API, email
```

Components:

| Component           | Responsibility                                                                                                |
| ------------------- | ------------------------------------------------------------------------------------------------------------- |
| `apps/web`          | Next.js UI. Never talks to the DB. Talks only to the API. Holds no secrets.                                   |
| `apps/api`          | NestJS REST API. AuthN/AuthZ, validation, domain logic, enqueues jobs, publishes SSE.                         |
| `workers`           | BullMQ consumers: health checks, webhook processing, automation, notifications, embeddings, AI investigation. |
| `packages/database` | Prisma schema, migrations, client, tenant-scoped query helpers, seed.                                         |
| `packages/shared`   | Zod schemas, enums (severity, status, permissions), API types shared by web/api/workers.                      |
| `packages/config`   | Shared tsconfig/eslint/prettier presets and typed env loading.                                                |
| `packages/ui`       | Deferred: components live in `apps/web` until a second consumer exists (see ADR-001).                         |

## 2. Layering in the API

```text
Controller (thin: parse, guard, call)  →  Service / use case (business rules)
   →  Repository (Prisma, always tenant-scoped)  →  PostgreSQL
                     └─► DomainEvents (in-process) ─► outbox/BullMQ jobs
```

- Controllers only: validate input with Zod pipes, apply guards, delegate, map results.
- Services own business rules (incident state machine, severity logic, threshold detection).
- Repositories take an explicit `TenantContext { organizationId }`; there is no method that queries an org-owned table without one.
- Cross-cutting: guards (auth, permissions), interceptors (request ID, audit), exception filter (uniform error envelope).

## 3. Core flows

### 3.1 Monitoring → incident

1. A scheduler enqueues a `health-check` job per enabled `MonitoringCheck` (BullMQ repeatable job, job id derived from check id so re-registration is idempotent).
2. Worker performs the HTTP request with timeout, records a `MonitoringResult`.
3. Consecutive-failure counter is computed from the last N results (not in-memory), so worker restarts and concurrency don't skew it.
4. On reaching `failureThreshold`, the service transitions service health to `DOWN` and emits `service.health_changed`.
5. Automation engine / built-in rule creates an incident. A partial unique index guarantees at most one active auto-created incident per service, so races cannot create duplicates.
6. The incident service writes an `IncidentEvent`, emits SSE, enqueues `notification` jobs.

### 3.2 GitHub webhook

1. `POST /api/v1/integrations/github/webhook` reads the **raw body**, verifies `X-Hub-Signature-256` with constant-time comparison against the per-integration secret.
2. Stores `WebhookEvent` with unique `(provider, deliveryId)`; duplicate deliveries are acknowledged and dropped (idempotency).
3. Responds 202 quickly; `webhook-processing` job normalises push/PR/deployment events into `Deployment` / commit records and links them to services and open incidents by time window and repository.

### 3.3 Incident lifecycle

State machine defined once in `packages/shared` and enforced in the service; DB `CHECK` and events reinforce it.

```text
OPEN → ACKNOWLEDGED → INVESTIGATING → MITIGATED → RESOLVED
  └────────────┴────────────┴────────────┴──► CANCELLED
RESOLVED → INVESTIGATING (reopen, permission-gated)
```

Every transition runs in one DB transaction: update incident, insert `IncidentEvent`, insert `AuditLog` (where sensitive), then after commit publish SSE and enqueue notification/automation jobs.

### 3.4 Automation

Rule = `trigger` (event type) + `conditions` (JSON, validated Zod schema: field/operator/value, AND-combined) + `actions` (typed list). Executions are recorded in `AutomationExecution` with a unique `(ruleId, eventId)` so redelivery does not double-run. Actions are an allow-list of typed handlers (`notify`, `create_incident`, `create_github_issue`, `webhook`); AI output can never trigger actions.

### 3.5 Notifications

`NotificationChannel` interface (`send(notification, recipient)`), implementations: `InAppChannel`, `EmailChannel` (SMTP/log transport in dev). Routing policy (severity → channels) is data, not code in incident services. Slack later = one new class + registration.

### 3.6 AI investigation

Detailed in [ai.md](ai.md) and ADR-006. Summary: worker assembles a bounded, tenant-scoped, ID-labelled context; calls Anthropic with tool use disabled; validates structured output with Zod; verifies every cited source ID exists in the assembled context; stores result in `AIInvestigation`.

## 4. Real-time strategy

Server-Sent Events (ADR-004). Updates are one-directional (server → browser), SSE works over plain HTTP with cookie auth, auto-reconnects, and needs no extra infrastructure beyond Redis pub/sub for fan-out across API instances. Channel per organisation; the API filters by permission before writing to a stream.

## 5. Observability _(planned Phase 10)_

- Structured JSON logs (pino) with `requestId`, `organizationId`, `userId`, `jobId`.
- `X-Request-Id` accepted/generated, propagated into job payloads so a worker log line links back to the originating request.
- OpenTelemetry SDK for HTTP, Prisma and BullMQ spans; OTLP exporter configured by env, off by default.
- `/health/live` and `/health/ready` (DB + Redis) endpoints.
- Secrets/PII redaction list in logger config.

## 6. Environments and deployment

- Dev: docker compose (postgres+pgvector, redis, api, web, worker) plus `pnpm dev` for hot reload.
- CI: GitHub Actions — lint, typecheck, unit, integration (service containers), build.
- Production: multi-stage Dockerfiles, non-root users, migrations run as an explicit release step (`prisma migrate deploy`), never on API boot.

## 7. Repository layout

```text
apps/api  apps/web  workers
packages/{database,shared,config}
docs/  tests/e2e  .github/workflows
```

`packages/ui` is intentionally not created yet.

## 8. Risks and trade-offs

| Risk                                             | Mitigation                                                                                                                                                                            |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scope is very large                              | Strict phases; each ends green (lint/type/test) before the next.                                                                                                                      |
| Tenant leakage via forgotten `where`             | Tenant-scoped repositories, `organizationId` on every owned table incl. children, composite FKs, cross-tenant integration tests, optional Postgres RLS as defence in depth (ADR-005). |
| pgvector requires extension                      | Use `pgvector/pgvector` image; embeddings behind an `EmbeddingProvider` interface.                                                                                                    |
| Anthropic has no embeddings endpoint             | Embedding provider is pluggable; default a local deterministic/lexical fallback + configurable provider (see ai.md). Retrieval degrades to Postgres full-text search.                 |
| Docker not installed on the author's dev machine | Docs and CI cover Docker; local dev also supports natively-installed Postgres/Redis via env vars.                                                                                     |
| Webhook and job duplication                      | Unique delivery IDs, deterministic BullMQ job IDs, unique execution keys.                                                                                                             |
| SSE behind proxies                               | Heartbeat comments, `X-Accel-Buffering: no`, documented.                                                                                                                              |
