# NEXUS Database Design

Status: Phase 0 design. Implemented as a Prisma schema in Phase 1–2 and extended per phase.

## Conventions

- **IDs:** UUIDv7-style UUIDs (`uuid` column, generated app-side) for all rows. Rationale: non-enumerable in URLs (limits IDOR probing), safe to generate in workers, time-ordered for index locality. Human-facing incident numbers are a separate per-org sequence (`number`).
- **Tenancy:** every org-owned table, _including children_ (e.g. `IncidentEvent`), carries `organization_id`. Child rows reference parents with composite FKs `(organization_id, parent_id)` so a child cannot point at another tenant's parent at the database level.
- **Timestamps:** `created_at`, `updated_at` as `timestamptz`.
- **Enums:** PostgreSQL enums mapped from shared TypeScript enums (single source in `packages/shared`).
- **Deletion:** Org-scoped data cascades from Organization. Users are never hard-deleted while referenced (`ON DELETE RESTRICT` on actor columns; actor identity denormalised into audit rows). Incidents/projects use soft delete (`archived_at`). `AuditLog` is append-only.
- **Secrets:** stored hashed (API keys, sha256 + prefix) or encrypted (integration secrets, AES-256-GCM with key from env). Never plaintext.

## Entities and relationships

```text
User ─< OrganizationMember >─ Organization
Organization ─< Project ─< Service ─< MonitoringCheck ─< MonitoringResult
Service ─< Incident ─< IncidentEvent / IncidentComment / IncidentAssignment / IncidentTag
Project ─< Deployment >─ GitHubRepository(GitHubIntegration)
Incident >─< Deployment   (IncidentDeployment link, with reason: SUSPECTED | CONFIRMED)
GitHubIntegration ─< WebhookEvent
Organization ─< AutomationRule ─< AutomationExecution
Organization ─< Notification (per recipient user)
Organization ─< KnowledgeDocument ─< KnowledgeChunk (embedding vector)
Incident ─< AIInvestigation
Organization ─< AuditLog, ApiKey
```

### Roles

`Role` is **not** a table of free-form roles: it is a Postgres enum (`OWNER, ADMIN, DEVELOPER, SUPPORT, VIEWER`) on `OrganizationMember.role`. Permissions are a static map in `packages/shared` (role → permission set). Rationale: the requirement is five fixed roles; a role/permission table adds joins and migration risk without a use case. Revisit if custom roles are needed.

### Tables (key columns, constraints, indexes)

**User** — `id`, `email` (citext, unique), `password_hash` (argon2id), `name`, `email_verified_at?`, `disabled_at?`.

**Organization** — `id`, `name`, `slug` (unique), `incident_counter` (for per-org numbering).

**OrganizationMember** — `(organization_id, user_id)` unique, `role`. Index on `user_id`. Constraint: each org must keep ≥1 OWNER (enforced in service inside a transaction with row lock).

**Session** — `id`, `user_id`, `token_hash` (unique), `expires_at`, `revoked_at?`, `ip`, `user_agent`. Opaque random session token in HttpOnly cookie; only its hash is stored (ADR-007).

**Project** — `organization_id`, `name`, `slug`; unique `(organization_id, slug)`.

**Service** — `organization_id`, `project_id` (composite FK), `name`, `environment` enum, `health_status` enum (`UNKNOWN, HEALTHY, DEGRADED, DOWN`), `health_changed_at`. Unique `(project_id, name, environment)`.

**MonitoringCheck** — `organization_id`, `service_id`, `type` (`HTTP`), `url`, `expected_status`, `timeout_ms` (CHECK 100–30000), `interval_seconds` (CHECK ≥ 15), `failure_threshold` (CHECK ≥ 1), `recovery_threshold`, `enabled`. URL validated against SSRF rules at write time and again at request time (see security.md).

**MonitoringResult** — `organization_id`, `check_id`, `status` (`UP/DOWN`), `status_code?`, `response_time_ms?`, `failure_reason?`, `checked_at`. Index `(check_id, checked_at DESC)`. Retention via `cleanup` job (default 30 days). Candidate for partitioning later; not needed initially.

**Incident** — `organization_id`, `number` (unique per org), `service_id?`, `title`, `description`, `severity` enum (`SEV1..SEV4`), `status` enum, `source` (`MANUAL, MONITORING, AUTOMATION, WEBHOOK`), `created_by_id?`, `acknowledged_at?`, `mitigated_at?`, `resolved_at?`, `archived_at?`. Indexes: `(organization_id, status, severity)`, `(organization_id, created_at DESC)`, `(service_id)`. **Partial unique index** `(service_id) WHERE source='MONITORING' AND status NOT IN ('RESOLVED','CANCELLED')` prevents duplicate auto-incidents. CHECK: `resolved_at` set iff status = RESOLVED.

**IncidentEvent** — append-only timeline. `organization_id`, `incident_id`, `type` enum (CREATED, ASSIGNED, SEVERITY_CHANGED, STATUS_CHANGED, COMMENT_ADDED, DEPLOYMENT_LINKED, AUTOMATION_EXECUTED, AI_INVESTIGATION_REQUESTED, AI_INVESTIGATION_COMPLETED, RESOLVED), `actor_type` (`USER, SYSTEM, AUTOMATION, AI`), `actor_id?`, `data` jsonb, `created_at`. Index `(incident_id, created_at)`.

**IncidentComment**, **IncidentAssignment** (`incident_id`, `user_id`, `assigned_by`, `unassigned_at?`; unique active assignee per incident+user), **IncidentTag** (`incident_id`, `tag`; unique together).

**GitHubIntegration** — `organization_id`, `installation/owner`, `repo_full_name`, `project_id?`, `webhook_secret_encrypted`, `status`. Unique `(organization_id, repo_full_name)`.

**Deployment** — `organization_id`, `project_id`, `service_id?`, `integration_id?`, `version`, `environment`, `commit_sha`, `commit_message?`, `author?`, `status`, `source_event_id?`, `deployed_at`. Unique `(integration_id, external_id)` for idempotent ingestion. Index `(organization_id, deployed_at DESC)`.

**IncidentDeployment** — `(incident_id, deployment_id)` PK, `relation`, `linked_by`.

**WebhookEvent** — `organization_id?` (resolved after signature check), `provider`, `delivery_id`, `event_type`, `payload` jsonb, `signature_valid`, `status` (`RECEIVED, PROCESSED, FAILED, IGNORED`), `error?`, `received_at`. Unique `(provider, delivery_id)`.

**AutomationRule** — `organization_id`, `name`, `trigger`, `conditions` jsonb, `actions` jsonb, `enabled`, `created_by`. **AutomationExecution** — `rule_id`, `event_key`, `status`, `result` jsonb, `started_at`, `finished_at`; unique `(rule_id, event_key)`.

**Notification** — `organization_id`, `user_id`, `type`, `title`, `body`, `link`, `read_at?`, `channel`. Index `(user_id, read_at, created_at DESC)`.

**KnowledgeDocument** — `organization_id`, `title`, `slug`, `content_md`, `tags`, `created_by`, `search_vector` (generated tsvector, GIN index). **KnowledgeChunk** — `organization_id`, `document_id` (composite FK), `ordinal`, `content`, `embedding vector(N)`, `content_hash`. HNSW/IVFFlat index on `embedding`; **every retrieval query filters `organization_id = $1` first**.

**AIInvestigation** — `organization_id`, `incident_id`, `requested_by`, `status`, `model`, `context_snapshot` jsonb (the exact labelled sources sent), `result` jsonb, `error?`, token counts, timestamps. Storing the snapshot makes citations inspectable after the fact.

**AuditLog** — append-only: `organization_id`, `actor_id?`, `actor_label`, `action` enum, `resource_type`, `resource_id`, `metadata` jsonb (redacted), `ip`, `request_id`, `created_at`. DB triggers reject UPDATE/DELETE (immutability enforced in Postgres, not just app). Index `(organization_id, created_at DESC)`.

**ApiKey** — `organization_id`, `name`, `prefix`, `key_hash` (unique), `permissions` (subset of role permissions), `last_used_at`, `expires_at?`, `revoked_at?`. Full key shown once.

## Tenant isolation layers

1. `organization_id` on every owned row + composite FKs.
2. Repositories require `TenantContext`; lint rule/test forbids raw Prisma usage for owned models outside repositories.
3. Optional defence in depth: Postgres Row Level Security with `SET LOCAL app.org_id` per transaction (evaluated in Phase 2; decision recorded in ADR-005).
4. Automated cross-tenant tests for every endpoint.

---

## Phase 2 as implemented

Migration `20260918120000_identity_organizations_sessions`. Conventions actually used: UUID primary keys from `gen_random_uuid()` (v4), Prisma default camelCase table and column names, `timestamptz` timestamps (see ADR-009).

| Table                | Purpose and key constraints                                                                                                                                                                                                 |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `User`               | `email` is `citext` and unique (case-insensitive). `passwordHash` must be an Argon2id PHC string (CHECK). `name` 1-100 chars (CHECK). `disabledAt` blocks login and existing sessions.                                      |
| `Organization`       | `slug` unique, lower-case-hyphen format and 3-63 chars (CHECK); `name` 1-100 chars (CHECK).                                                                                                                                 |
| `OrganizationMember` | `role` is the `Role` enum. Unique `(organizationId, userId)` and unique `(organizationId, id)` (the composite key later tenant tables reference). FK to organisation cascades; FK to user is `RESTRICT`. Index on `userId`. |
| `Session`            | `tokenHash` unique (SHA-256 of the cookie token). `expiresAt` (idle, sliding) must be after `createdAt` and no later than `absoluteExpiresAt` (CHECK). `revokedAt` for revocation. Cascades from user.                      |

The "at least one OWNER per organisation" rule is enforced in the service under a row lock on the organisation (a database-only constraint would need a deferred trigger); concurrent demotion is covered by an integration test.

Not yet implemented from the design above: `Project`, `Service`, incidents, monitoring, integrations, automation, notifications, knowledge, AI, `AuditLog` and `ApiKey`.

---

## Phase 3 as implemented

Migration `20260919090000_projects_services_incidents`.

| Table                | Purpose and key constraints                                                                                                                                                                                                                                                                                                                                                                        |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Project`            | Unique `(organizationId, slug)` and `(organizationId, id)`. Name 1-100 and slug format enforced by CHECK. Soft-deleted via `archivedAt`.                                                                                                                                                                                                                                                           |
| `Service`            | Composite FK `(organizationId, projectId)` to `Project`. Unique `(organizationId, projectId, name, environment)`. `healthStatus` defaults to `UNKNOWN` ("not monitored"), set by monitoring in Phase 4.                                                                                                                                                                                            |
| `Incident`           | Per-organisation `number` (unique with `organizationId`, allocated from `Organization.incidentCounter` in the creating transaction). Optional composite FK `(organizationId, serviceId)` to `Service`. CHECKs: title 1-200, description at most 10 000, `number > 0`, and status/timestamp agreement (`RESOLVED` exactly when `resolvedAt` is set; `CANCELLED` exactly when `cancelledAt` is set). |
| `IncidentEvent`      | The timeline. Composite FK to `Incident`. **Append-only: database triggers reject UPDATE, DELETE and TRUNCATE.** Actor is typed (`USER`, `SYSTEM`, `AUTOMATION`, `AI`); `data` is JSON.                                                                                                                                                                                                            |
| `IncidentComment`    | Composite FK to `Incident`; body 1-5000 (CHECK). Comments are immutable (no edit or delete API).                                                                                                                                                                                                                                                                                                   |
| `IncidentAssignment` | Composite FK to `Incident`. Ending an assignment sets `unassignedAt` (history kept). A **partial unique index** allows one active row per `(incidentId, userId)`.                                                                                                                                                                                                                                  |
| `IncidentTag`        | Composite primary key `(incidentId, tag)`; tag format enforced by CHECK.                                                                                                                                                                                                                                                                                                                           |

### How tenant isolation is enforced by the database

Every child references its parent through a composite foreign key `(organizationId, parentId)` that points at the parent's `(organizationId, id)` unique key. A row therefore cannot reference a parent belonging to another organisation, no matter what the application does. This is tested by inserting cross-tenant rows with raw SQL, bypassing the application, and asserting PostgreSQL refuses them. Deleting an incident that has history is refused (`ON DELETE RESTRICT`); incidents are never hard-deleted.

**Row Level Security is deliberately not enabled.** In development, CI and Docker Compose the application connects as the bootstrap superuser (`POSTGRES_USER`), and PostgreSQL superusers bypass RLS, so policies would look protective while enforcing nothing. RLS needs a separate non-superuser application role plus per-transaction session variables; it is planned as part of Phase 10 hardening (see ADR-010).

### Incident numbering

`Organization.incidentCounter` is incremented with a single atomic `UPDATE` inside the incident-creation transaction. The row lock serialises concurrent creation, and a rollback also rolls the counter back, so numbers are gap-free and never reused. A test creates eight incidents concurrently and asserts `1..8`.

Not yet implemented from the design above: knowledge, `AIInvestigation` and `ApiKey`.

---

## Phase 4 as implemented

Migration `20260919180000_monitoring`.

| Table / column            | Purpose and key constraints                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `MonitoringCheck`         | Composite FK `(organizationId, serviceId)` to `Service`. Configuration (`url`, `expectedStatus`, `timeoutMs`, `intervalSeconds`, `failureThreshold`, `recoveryThreshold`, `incidentSeverity`, `createIncidents`, `enabled`) **and** runtime state (`healthStatus`, `consecutiveFailures`, `consecutiveSuccesses`, `lastCheckedAt`, `nextRunAt`). CHECK constraints bound every setting (timeout 100-30000 ms, interval 15-86400 s, thresholds 1-20, status 100-599, URL is http(s), counters non-negative, verdict is UNKNOWN/HEALTHY/DOWN). Index `(enabled, nextRunAt)` serves the dispatcher. |
| `MonitoringResult`        | Composite FK `(organizationId, checkId)` to `MonitoringCheck` (cascade on delete). **Unique `(checkId, scheduledFor)`**: makes result recording idempotent. CHECK: a DOWN result must carry a `failureReason` and an UP result must not. Index `(checkId, checkedAt DESC)` for the results view and `(checkedAt)` for retention.                                                                                                                                                                                                                                                                 |
| `Service.healthChangedAt` | When the aggregated health last changed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `Incident`                | New CHECK: a `MONITORING` incident must name a service. New **partial unique index** `Incident_one_active_monitoring_per_service`: at most one active (not RESOLVED/CANCELLED) monitoring incident per service.                                                                                                                                                                                                                                                                                                                                                                                  |
| `IncidentEventType`       | Adds `MONITORING_SIGNAL` (recorded by monitoring on an incident it created, e.g. "recovered").                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

`failureReason` is stored as text drawn from the closed set `FAILURE_REASONS` in `@nexus/shared` (`timeout`, `dns_failure`, `connection_refused`, `connection_reset`, `tls_error`, `unexpected_status`, `blocked_address`, `invalid_url`, `request_error`).

Results are deleted after `MONITORING_RESULT_RETENTION_DAYS` (default 30) by an hourly maintenance job; a service's health and its incidents are unaffected. At high volume `MonitoringResult` is the table to partition by `checkedAt`; not needed yet.

---

## Phase 5 as implemented

Migration `20260920100000_github_integration`. All four tables use the same composite tenant-safe foreign keys as Phase 3.

- **`GitHubIntegration`**: `repoFullName`, `projectId`, optional `serviceId`, `webhookSecretEncrypted` (AES-256-GCM, bound to the row id), `status` (`ACTIVE`/`DISABLED`), `lastEventAt`. A **partial unique index** allows one ACTIVE integration per repository (case-insensitive) per organisation. Integrations are disabled, never deleted.
- **`WebhookEvent`**: only signature-verified deliveries. `deliveryId` is unique **per integration** (a deliberate change from the Phase 0 sketch, which had `(provider, deliveryId)`), `payload` jsonb, `status` (`RECEIVED`, `PROCESSED`, `FAILED`, `IGNORED`), `error`. Deleted after `WEBHOOK_RETENTION_DAYS`.
- **`Deployment`**: unique per `(integrationId, externalId)`; `status` (`PENDING`, `IN_PROGRESS`, `SUCCESS`, `FAILURE`, `INACTIVE`), `startedAt`, `deployedAt` (first success), `statusUpdatedAt` (newest status applied). CHECK constraints on the commit sha and text lengths.
- **`IncidentDeployment`**: primary key `(incidentId, deploymentId)`, `relation` (`SUSPECTED`/`CONFIRMED`), `linkedById`. The database refuses a link between an incident and a deployment of different organisations.
- `IncidentEventType` gains `DEPLOYMENT_LINKED`.

Not stored, on purpose: commit messages (`deployment_status` does not carry them) and events of types NEXUS does not use.

---

## Phase 6 as implemented

Migrations `20260921100000_automation` and `20260921110000_notification_delivery`. Every table has `organizationId` and the composite tenant-safe foreign keys used elsewhere.

- **`DomainEvent`**: the outbox. `type` (a trigger name, text with a CHECK constraint that mirrors `@nexus/shared`, so the same string is used at every layer), `subjectId`, `facts` (a flat JSON object, CHECK-enforced), `causedByExecutionId` (set for events an automation caused: the loop guard), `dispatchedAt`. A partial index keeps the "still to do" scan tiny.
- **`AutomationRule`**: `trigger`, `conditions` and `actions` (JSON validated by `@nexus/shared` on every write; CHECKs bound their size), `enabled`, `cooldownSeconds` (0 to 86400).
- **`AutomationExecution`**: **unique `(ruleId, eventId)`**, `status` (`PENDING`, `RUNNING`, `SUCCEEDED`, `PARTIAL`, `FAILED`, `SKIPPED`), `skipReason` (only on a skipped execution, CHECK-enforced), per-action `results`, `attempts`.
- **`Notification`**: per recipient. The composite key to `OrganizationMember` means it can only exist for a member of its own organization. **Unique `(executionId, actionIndex, userId)`**, `inApp`, `emailStatus` (`NONE`, `PENDING`, `SENT`, `FAILED`), a short `emailError`, and a `link` CHECK-limited to in-app paths (`/orgs/…`).
- **`OutboundWebhook`**: `url` (http(s) only), `secretEncrypted` (AES-256-GCM bound to the row id), `enabled`.
- **`AuditLog`**: **append-only**: triggers (the same function as the incident timeline) reject UPDATE, DELETE and TRUNCATE, and the organization foreign key is `RESTRICT`, so it cannot be silently emptied. `actorLabel` is a snapshot of who acted. Metadata is redacted before it is written.
- `IncidentEventType` gains `AUTOMATION_EXECUTED`.

Retention: dispatched events (with their executions) and notifications are deleted after `AUTOMATION_RETENTION_DAYS` and `NOTIFICATION_RETENTION_DAYS`. Undispatched events and the audit log are never deleted by retention.
