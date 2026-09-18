# ADR-003: Redis + BullMQ for background work

**Status:** Accepted

## Context

Health checks, webhook processing, automations, notifications, embeddings and AI calls are slow or unreliable and must not run in request handlers.

## Problem

Need retries, backoff, scheduling, concurrency control and visibility.

## Options considered

1. In-process timers: lost on restart, no retries, doesn't scale.
2. Postgres-backed queue: fewer moving parts but weaker scheduling/backoff tooling.
3. Redis + BullMQ (also needed for rate limiting and SSE pub/sub).

## Decision

BullMQ with deterministic job IDs for idempotency, exponential backoff, dead-letter inspection, and a separate worker process. Jobs carry the request ID for tracing. Handlers must be idempotent (unique keys in the DB).

## Consequences

Redis becomes a required dependency; job payloads must be small and contain IDs, not data. Redis is not the source of truth; the DB is.
