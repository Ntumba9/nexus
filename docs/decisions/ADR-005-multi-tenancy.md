# ADR-005: Shared-schema multi-tenancy with layered isolation

**Status:** Accepted (RLS portion to be confirmed in Phase 2)

## Context

Multiple organisations share one deployment. Leakage is the most damaging failure.

## Problem

Enforce isolation without relying on every developer remembering a `where`.

## Options considered

1. Database per tenant: strongest isolation, high operational cost.
2. Schema per tenant: migration complexity.
3. Shared schema with `organization_id` everywhere.

## Decision

Shared schema. Layers: (a) `organization_id` on every owned table incl. children with composite FKs; (b) repositories that require a `TenantContext`; (c) membership guard deriving org from the session; (d) cross-tenant integration tests per endpoint; (e) evaluate Postgres RLS via `SET LOCAL app.org_id` as defence in depth, adopted if it works cleanly with Prisma transactions.

## Consequences

Cheap to operate; isolation depends on discipline plus tests and DB constraints. Some denormalisation of `organization_id`.
