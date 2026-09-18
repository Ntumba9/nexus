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
