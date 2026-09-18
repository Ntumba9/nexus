# ADR-010: Incident domain design and database-level tenant enforcement

**Status:** Accepted (Phase 3). Refines ADR-005 (multi-tenancy).

## Context

Phase 3 introduced the first large tenant-owned tables (projects, services, incidents and their history). ADR-005 and ADR-009 promised composite tenant keys and a decision on PostgreSQL Row Level Security (RLS) at this point.

## Decisions

1. **Composite foreign keys are the database-level tenant guarantee.** Every child references its parent through `(organizationId, parentId)` to the parent's `(organizationId, id)` unique key. A cross-tenant reference is impossible regardless of application code, for every database role. Optional parents (`Incident.serviceId`) use the default MATCH SIMPLE semantics, so the check applies whenever the optional column is set. Tests insert cross-tenant rows with raw SQL and assert PostgreSQL rejects them.
2. **RLS is not enabled yet, on purpose.** The application currently connects as the bootstrap superuser (`POSTGRES_USER`) in development, CI and Compose, and superusers bypass RLS. Enabling policies now would appear protective while enforcing nothing, which is worse than being honest. RLS needs (a) a separate non-superuser application role, (b) `SET LOCAL app.organization_id` inside every tenant transaction, and (c) tests that connect as that role. That work is scheduled with Phase 10 hardening. Until then, isolation rests on the composite keys, tenant-scoped queries, the membership guard and cross-tenant tests.
3. **The incident timeline is append-only in the database.** `UPDATE`, `DELETE` and `TRUNCATE` on `IncidentEvent` are rejected by triggers, so no application bug or console session can rewrite history. The trade-off is that deleting an organisation is not possible while it has incidents; organisations and incidents are archived, never deleted.
4. **One state machine, defined in `packages/shared`.** The legal transitions, the permission required for each (resolving and reopening need `incidents.resolve`), and the "allowed next steps for this caller" are all computed from the same table by the API and the web app. The API remains the enforcement point; a database CHECK additionally guarantees `status` and `resolvedAt`/`cancelledAt` never disagree.
5. **Transitions use optimistic concurrency** (`UPDATE ... WHERE status = <validated status>`) rather than long-held locks, so simultaneous conflicting transitions produce exactly one success and one 409.
6. **Events are written in the same transaction as the change**, so the timeline can never disagree with the state.
7. **Incident numbers come from a per-organisation counter** incremented in the creating transaction (gap-free, never reused, human-friendly `INC-42`), instead of a global sequence or `max(number)+1` (racy).
8. **Assignees are validated against organisation membership in the service**, not by a composite key to `OrganizationMember`, because removing a member would then be blocked by their historical assignments. Assignment history is kept (`unassignedAt`), and a partial unique index allows one active assignment per user per incident.
9. **Service health starts as `UNKNOWN` and the dashboard says so.** Nothing may present "no data" as "healthy"; the health column is written by monitoring in Phase 4.

## Consequences

Tenant isolation holds even if application code is wrong, and history is tamper-resistant. The costs are that some mistakes surface as database errors rather than friendly messages (the service checks first to give proper 404s), incidents cannot be hard-deleted, and RLS remains a tracked follow-up rather than a shipped control.
