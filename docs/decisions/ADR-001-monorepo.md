# ADR-001: pnpm monorepo

**Status:** Accepted

## Context

Web, API and workers share enums, Zod schemas, the Prisma client and config.

## Problem

Keep types and validation in sync across three runtimes without publishing packages.

## Options considered

1. Separate repos: type drift, painful cross-cutting changes.
2. Single package: workers/API/web couple at build level.
3. pnpm workspaces monorepo (optionally with Turborepo).

## Decision

pnpm workspaces with `apps/*`, `workers`, `packages/*`. Add Turborepo only if build caching becomes necessary. `packages/ui` is **not** created until a second consumer exists; components live in `apps/web`.

## Consequences

One lockfile, atomic cross-package changes, shared CI. Slightly more tooling setup; TypeScript project references needed for fast builds.
