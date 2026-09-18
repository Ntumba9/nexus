# Contributing

## Setup

See "Local development" in the [README](README.md).

## Before opening a pull request

```bash
pnpm lint && pnpm format:check && pnpm typecheck && pnpm test && pnpm build
pnpm test:integration   # if you touched the database, queues or workers (needs Docker services)
```

CI runs the same gates and fails on any of them.

## Conventions

- TypeScript strict mode; no `any` without a documented reason.
- Controllers stay thin; business logic lives in services. Validate all external input with Zod.
- Every organisation-owned query must be tenant-scoped (see [docs/decisions/ADR-005-multi-tenancy.md](docs/decisions/ADR-005-multi-tenancy.md)).
- Add a dependency only with a concrete need; mention it in the PR.
- Significant architectural decisions get an ADR in `docs/decisions/`.
- Never commit secrets or a real `.env`.
