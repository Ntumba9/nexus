# NEXUS

**Developer operations and incident intelligence platform.**

> **Status: Phase 1 complete (foundation).** The monorepo, API, web app, workers, database
> package, Docker Compose setup and CI workflow exist. Lint, typecheck, unit tests and builds pass locally;
> Docker-dependent pieces (compose, Dockerfiles, integration tests) are written but **not yet run**
> because Docker was unavailable when they were written. Product features
> (authentication, incidents, monitoring, GitHub, AI…) are **not built yet** — see the
> [roadmap](#roadmap). Sections describing features are the target design.

## What it is

NEXUS is a multi-tenant platform where teams register services, monitor them, detect and manage
incidents, connect GitHub, automate responses, keep an internal knowledge base, and use AI
(Anthropic) as an evidence-citing investigation assistant.

```text
Service → Monitoring → Detection → Incident → Investigation → Automation → Resolution → Record
```

## Why it exists

Incident tooling is usually split across monitors, chat, ticketing and docs. NEXUS keeps the
incident timeline, deploy history, runbooks and investigation in one place, and stays fully
useful when the AI provider is unavailable.

## What works today

- `GET /health/live` and `GET /health/ready` (PostgreSQL + Redis) on the API, with Swagger UI at `/api/docs`
- Web status page that shows live platform health from the API (with an error state)
- Worker process with a BullMQ `system` queue and a `ping` smoke job proving the Redis → worker pipeline
- PostgreSQL with pgvector and citext enabled through a Prisma migration
- Validated environment configuration (fails fast, never echoes secret values)
- CI: lint, format check, typecheck, unit tests, build, integration tests, Docker image build

## Architecture

```text
apps/web (Next.js) ─► apps/api (NestJS) ─► PostgreSQL + pgvector
                          │
                          └─► Redis ◄─ workers (BullMQ consumers)
```

Details: [docs/architecture.md](docs/architecture.md). Decisions: [docs/decisions/](docs/decisions/).

| Path                | Purpose                                                              |
| ------------------- | -------------------------------------------------------------------- |
| `apps/web`          | Next.js 16 (App Router), Tailwind CSS 4                              |
| `apps/api`          | NestJS 11 REST API, OpenAPI                                          |
| `workers`           | BullMQ workers + small health HTTP server                            |
| `packages/database` | Prisma schema, migrations, client factory                            |
| `packages/shared`   | Zod contracts shared by web/api/workers (health report, queue names) |
| `packages/config`   | Typed, validated environment loading                                 |

## Tech stack

TypeScript (strict) · Next.js · NestJS · PostgreSQL + pgvector · Prisma · Redis · BullMQ · Zod ·
Tailwind CSS · Vitest · Supertest · ESLint · Prettier · Docker Compose · GitHub Actions.
Later phases add: Playwright, TanStack Query, React Hook Form, shadcn/ui components, OpenTelemetry
and the Anthropic SDK — each is added when a feature first needs it.

## Local development

### Prerequisites

- Node.js **22 or newer** (`.nvmrc` says 22)
- pnpm **10** (`corepack enable` picks the exact version from `package.json`)
- [Docker Desktop](https://www.docker.com/products/docker-desktop/) for PostgreSQL and Redis. On Windows it runs
  on WSL 2, which needs **hardware virtualization enabled in BIOS/UEFI** and the **Virtual Machine Platform**
  Windows feature (Administrator PowerShell: `wsl --install --no-distribution`, then restart).

### First-time setup

```bash
pnpm install                 # also generates the Prisma client
cp .env.example .env         # development-only placeholders
pnpm env:check               # shows which env vars are set/missing (never prints values)
pnpm dev:infra               # starts PostgreSQL (pgvector) and Redis, waits until healthy
pnpm db:migrate:deploy       # applies migrations (enables pgvector + citext)
```

### Run the apps

```bash
pnpm dev                     # web :3000, api :3001, worker :3002 (health)
```

| URL                                | What             |
| ---------------------------------- | ---------------- |
| http://localhost:3000              | Web status page  |
| http://localhost:3001/health/ready | API readiness    |
| http://localhost:3001/api/docs     | Swagger UI       |
| http://localhost:3002/health/ready | Worker readiness |

Verify the queue pipeline (with `pnpm dev` running):

```bash
pnpm --filter @nexus/workers smoke
```

PostgreSQL is published on host port **5433** (not 5432) so it cannot clash with a PostgreSQL
already installed on your machine. Change `POSTGRES_HOST_PORT` and `DATABASE_URL` in `.env` to
alter it.

### No local Docker? Two alternatives

**GitHub Codespaces (recommended):** open the repository in a Codespace. `.devcontainer/` installs
dependencies and starts PostgreSQL (pgvector) and Redis with Docker-in-Docker automatically. Then
run `pnpm db:migrate:deploy` and `pnpm dev`.

**Hosted services:** set `DATABASE_URL` (Neon, direct non-pooled connection string; supports pgvector)
and `REDIS_URL` (Upstash, `rediss://…`) in your local `.env`, then `pnpm db:migrate:deploy`. Free
Redis tiers meter commands and BullMQ polls constantly, so Codespaces or local Docker is safer for
workers. Never commit `.env`.

### Full stack in Docker

```bash
docker compose --profile app up --build
```

This adds a one-shot `migrate` service, then `api`, `web` and `worker`. Without `--profile app`
only PostgreSQL and Redis start.

## Environment variables

All variables are validated at startup by `packages/config`; a missing or invalid value stops the
process with a message naming the variable (never its value). See [.env.example](.env.example).

| Variable                                                     | Used by      | Notes                                        |
| ------------------------------------------------------------ | ------------ | -------------------------------------------- |
| `DATABASE_URL`                                               | api          | `postgresql://…`                             |
| `REDIS_URL`                                                  | api, workers | `redis://…`                                  |
| `API_HOST`, `API_PORT`                                       | api          | default `0.0.0.0:3001`                       |
| `WEB_ORIGIN`                                                 | api          | CORS origin, default `http://localhost:3000` |
| `SWAGGER_ENABLED`                                            | api          | `true`/`false`                               |
| `API_INTERNAL_URL`                                           | web          | server-side URL of the API                   |
| `WORKER_CONCURRENCY`, `WORKER_HEALTH_HOST/_PORT`             | workers      | defaults `5`, `0.0.0.0:3002`                 |
| `NODE_ENV`, `LOG_LEVEL`                                      | all          |                                              |
| `POSTGRES_PASSWORD`, `POSTGRES_HOST_PORT`, `REDIS_HOST_PORT` | compose      | Docker only                                  |

In production `.env` is never loaded; configuration must come from the real environment.

## Database

Prisma schema: `packages/database/prisma/schema.prisma`. Phase 1 declares no domain tables — only
the datasource and the `vector` and `citext` extensions, applied by the first migration. Domain
models arrive with the phases that need them ([docs/database.md](docs/database.md)).

```bash
pnpm db:migrate:dev          # create/apply a migration while developing
pnpm db:migrate:deploy       # apply committed migrations (CI, Docker)
pnpm db:generate             # regenerate the Prisma client
```

## Testing and quality

```bash
pnpm lint
pnpm format:check            # `pnpm format` to fix
pnpm typecheck
pnpm test                    # unit tests, no infrastructure needed
pnpm build
pnpm test:integration        # needs PostgreSQL + Redis (pnpm dev:infra, migrations applied)
```

Integration tests skip themselves when `DATABASE_URL` / `REDIS_URL` are not set.

## Deployment

Production Docker configuration is a Phase 12 deliverable. The current Dockerfiles are written but
not yet built or size-optimised (Docker was unavailable); migrations are an explicit step (`migrate` service), never
run on API start.

## Security

See [SECURITY.md](SECURITY.md) and [docs/security.md](docs/security.md) (threat model). Phase 1
security posture: validated config, Helmet headers, CORS restricted to `WEB_ORIGIN`, no secrets in
the repo, coarse client-facing health errors with detail only in server logs. Authentication,
authorization and tenant isolation are Phase 2+.

## AI architecture

Design only so far: [docs/ai.md](docs/ai.md). Embeddings will sit behind a provider interface with a
local development fallback; no paid embedding provider is configured.

## Documentation

[architecture](docs/architecture.md) · [database](docs/database.md) · [security](docs/security.md) ·
[api](docs/api.md) · [ai](docs/ai.md) · [decisions](docs/decisions/)

## Roadmap

| Phase | Scope                                         | Status  |
| ----- | --------------------------------------------- | ------- |
| 0     | Architecture and design docs                  | Done    |
| 1     | Monorepo, Next.js, NestJS, Prisma, Docker, CI | Done    |
| 2     | Auth, organisations, RBAC                     | Next    |
| 3     | Projects, services, incidents, dashboard      | Planned |
| 4     | Monitoring and workers                        | Planned |
| 5     | GitHub integration                            | Planned |
| 6     | Automation and notifications                  | Planned |
| 7     | Real-time                                     | Planned |
| 8     | Knowledge base and RAG                        | Planned |
| 9     | AI investigation                              | Planned |
| 10    | Security hardening and observability          | Planned |
| 11    | Comprehensive testing                         | Planned |
| 12    | Production polish and demo                    | Planned |

## License

[MIT](LICENSE)
