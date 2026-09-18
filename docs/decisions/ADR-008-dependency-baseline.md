# ADR-008: Dependency baseline and module format

**Status:** Accepted (Phase 1)

## Context

At the start of Phase 1 the newest releases were: NestJS 12 (ESM-only), Prisma 8 (release candidate only; 7.x requires driver adapters and a new config model), TypeScript 7 (brand new) and ESLint 10.

## Problem

Choose versions for a foundation that many later phases build on, where debugging toolchain incompatibilities would cost more than any feature in newer majors.

## Options considered

1. Take every latest major: highest risk of ecosystem gaps (plugins, typings, docs).
2. Stay on well-established majors and revisit deliberately.

## Decision

Pin exact versions of: NestJS 11, Prisma 6.19, TypeScript 5.9, ESLint 9, Vitest 3, BullMQ 5 with ioredis 5. Keep Next.js 16, React 19, Tailwind 4 and Zod 4, which are stable and used as intended. Server-side packages compile to CommonJS with `tsc` (module `nodenext`); internal packages (`config`, `shared`, `database`) are built to `dist/` and consumed via `main`/`types`, so typecheck, tests and CI build packages first. The API uses explicit `@Inject(...)` tokens so it also runs under test runners that do not emit decorator metadata.

## Consequences

Stable, well-documented toolchain now. Upgrading to NestJS 12 (ESM) or Prisma 7+ will be a deliberate migration (likely ESM across the repo and Prisma driver adapters) recorded in a later ADR. Exact pins mean upgrades happen through reviewed PRs.
