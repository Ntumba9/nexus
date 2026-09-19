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

### 3.2 GitHub webhook _(implemented in Phase 5; see ADR-012)_

1. `POST /api/v1/webhooks/github/:integrationId` reads the **raw body** and verifies `X-Hub-Signature-256` (HMAC-SHA256, constant-time) against that integration's secret, which is stored AES-256-GCM encrypted. A bad signature is answered 401 and nothing is stored.
2. A verified `deployment_status` or `ping` delivery is stored as a `WebhookEvent`, unique per `(integration, deliveryId)`; a redelivery is acknowledged as a duplicate. Other event types are acknowledged and not stored.
3. It responds 202 quickly and enqueues a `webhook-processing` job. The worker upserts a `Deployment` (unique per integration and GitHub deployment id, ignoring out-of-order statuses) and marks the event processed.
4. Deployments are suggested on incidents for the same service shortly before they began, and a person links them (`SUSPECTED` or `CONFIRMED`), which is recorded on the timeline. Push and pull-request events are not normalised yet.

### 3.3 Incident lifecycle

State machine defined once in `packages/shared` and enforced in the service; DB `CHECK` and events reinforce it.

```text
OPEN → ACKNOWLEDGED → INVESTIGATING → MITIGATED → RESOLVED
  └────────────┴────────────┴────────────┴──► CANCELLED
RESOLVED → INVESTIGATING (reopen, permission-gated)
```

Every transition runs in one DB transaction: update incident, insert `IncidentEvent`, insert `AuditLog` (where sensitive), then after commit publish SSE and enqueue notification/automation jobs.

### 3.4 Automation _(implemented in Phase 6; see ADR-013)_

`change → DomainEvent (same transaction) → dispatcher → rule evaluation → AutomationExecution → actions → recorded result → AuditLog`

1. **Announce.** Whatever changes something automation may care about writes a `DomainEvent` in the same transaction: every incident timeline event goes through `recordIncidentEvent`, service health changes through `recomputeServiceHealth`, deployments through the worker's upsert. A rolled-back change leaves no event.
2. **Dispatch.** A worker loop claims undispatched events (`FOR UPDATE SKIP LOCKED`), loads the enabled rules of the event's own organization for that trigger, evaluates their conditions against the event's flat facts, applies the cooldown and hourly cap, and records one `AutomationExecution` per match (unique per rule and event), marking the event dispatched in the same transaction. Events caused by an automation never run rules (no chains).
3. **Execute.** A BullMQ job per execution runs the rule's typed actions (`notify`, `webhook`, `create_incident`), saving each result as it goes, so a retry resumes and never repeats finished work.
4. **Record.** The verdict (`SUCCEEDED`, `PARTIAL`, `FAILED`, `SKIPPED`) and each action's result are stored; a run about an incident is noted on its timeline; changes to rules and automation-opened incidents go to the append-only audit log.

### 3.5 Notifications _(implemented in Phase 6)_

`notify` writes one `Notification` per recipient (the delivery record: inbox row plus email status) and sends email through a transport seam (`log` by default, or SMTP). Routing is data: the rule says who (roles, named members, the incident's assignees, the person assigned) and which channels. Recipients are re-checked against current membership when the action runs. Slack or another channel is one new transport, not a redesign.

### 3.6 AI investigation

Detailed in [ai.md](ai.md) and ADR-006. Summary: worker assembles a bounded, tenant-scoped, ID-labelled context; calls Anthropic with tool use disabled; validates structured output with Zod; verifies every cited source ID exists in the assembled context; stores result in `AIInvestigation`.

## 4. Real-time strategy _(implemented in Phase 7, ADR-014)_

Server-Sent Events (ADR-004). Updates are one-directional (server → browser), SSE works over plain HTTP with cookie auth, auto-reconnects, and needs no extra infrastructure beyond Redis pub/sub for fan-out across API instances. Channel per organisation; the API filters by permission before writing to a stream. Messages are signals (`{ topic, userId? }`), never data: the browser refetches through REST, so authorization lives in one place. The API publishes after successful mutations, workers publish after their own changes (the automation dispatcher announces every outbox event), and each open stream re-checks its member and session on every heartbeat. Details and limits: [ADR-014](decisions/ADR-014-realtime-implementation.md).

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
