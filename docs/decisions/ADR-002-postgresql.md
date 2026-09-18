# ADR-002: PostgreSQL with Prisma (and pgvector)

**Status:** Accepted

## Context

Data is strongly relational (orgs, incidents, timelines) and needs constraints, transactions, full-text search and vector search.

## Problem

Choose storage that enforces integrity and tenancy in the database and avoids a second datastore for embeddings.

## Options considered

1. MongoDB: weak relational integrity.
2. PostgreSQL + separate vector DB: extra infrastructure and a second tenancy boundary.
3. PostgreSQL + pgvector.

## Decision

PostgreSQL with Prisma for schema/migrations/typed queries, pgvector for embeddings. Raw SQL (parameterised) for partial indexes, triggers, CHECK constraints and vector queries that Prisma can't express.

## Consequences

One datastore, transactional consistency between incidents and knowledge. Requires the pgvector image/extension. Some constraints live in hand-written migration SQL.
