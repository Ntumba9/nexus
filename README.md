# NEXUS

**Developer operations and incident intelligence platform.**

> **Status: Phase 4 complete (monitoring).** Accounts, organizations, RBAC, projects, services,
> incident management, the dashboard and HTTP monitoring with automatic incident creation are built
> and tested in CI (unit, API and worker integration against real PostgreSQL and Redis, and
> Playwright end-to-end). GitHub, automation, real-time updates, the knowledge base and AI are **not
> built yet**; see the [roadmap](#roadmap). Sections describing those features are the target design.

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

- Register, log in and log out with Argon2id passwords and opaque, revocable, hashed session tokens in HttpOnly cookies; rate-limited auth endpoints
- Organizations with onboarding, an organization switcher and settings; members with five roles (OWNER, ADMIN, DEVELOPER, SUPPORT, VIEWER)
- One explicit permission matrix enforced by default-deny guards; tenant isolation tested (a user cannot reach another organization by changing an id)
- Projects and services (with archive), and incident management: a real lifecycle (OPEN → ACKNOWLEDGED → INVESTIGATING → MITIGATED → RESOLVED, plus cancel and reopen), typed severities SEV-1 to SEV-4, per-organization incident numbers (INC-42), assignments, comments and a complete, tamper-resistant timeline
- HTTP health monitoring: per-service checks with an expected status, timeout, interval and failure/recovery thresholds. A service is only DOWN after N consecutive failures (never on one blip); it then opens exactly one incident (severity configurable), and recovery is recorded on that incident but left for a human to resolve. "Check now", result history with failure reasons, and result retention
- Background workers on Redis + BullMQ: a database-driven scheduler that is safe with several workers, idempotent check execution, retries, and an hourly retention job
- SSRF-safe monitoring: checks cannot be pointed at localhost, private networks or cloud-metadata addresses (validated when saved and again on every request with DNS pinning), redirects are never followed and response bodies are never read
- Overview dashboard built from real data: active incidents by severity, service health (real once checks exist; "not monitored" otherwise), 14-day trend, recent incidents and activity
- Authenticated web app shell (dark UI): login, register, onboarding, dashboard, projects, services, incidents, settings and members, with loading, error and empty states
- Tenant isolation enforced by the database as well as the application (composite foreign keys), proven by cross-tenant tests that bypass the API with raw SQL
- `GET /health/live` and `GET /health/ready` (PostgreSQL + Redis) on the API, with Swagger UI at `/api/docs`; a platform status page at `/status`
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
Tailwind CSS · TanStack Query · React Hook Form · Argon2id · Vitest · Supertest · Playwright ·
ESLint · Prettier · Docker Compose · GitHub Actions. Later phases add OpenTelemetry and the
Anthropic SDK — each dependency is added when a feature first needs it.

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

Try monitoring locally: set `MONITORING_ALLOW_PRIVATE_NETWORKS=true` in `.env` (so a check may target
`http://localhost:3001/health/live`), restart, open a service, and add a health check. The worker
runs it within seconds; stop the API to watch the service go DOWN and an incident open.

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

Run the prebuilt images published to GitHub Container Registry (no local build):

```bash
docker compose --profile app pull
docker compose --profile app up --no-build
```

Or build them from source instead:

```bash
docker compose --profile app up --build
```

This adds a one-shot `migrate` service, then `api`, `web` and `worker`. Without `--profile app`
only PostgreSQL and Redis start.

Images are `ghcr.io/ntumba9/nexus-{api,web,worker}`, published by CI for every green commit on
`main`, tagged `latest` and with the full commit SHA. Set `NEXUS_IMAGE_TAG` in `.env` to pin a
version, or `NEXUS_IMAGE_REGISTRY` to use a fork. If the packages are private,
`docker login ghcr.io` first with a token that has `read:packages`.

## Environment variables

All variables are validated at startup by `packages/config`; a missing or invalid value stops the
process with a message naming the variable (never its value). See [.env.example](.env.example).

| Variable                                                              | Used by      | Notes                                                                                                                                                      |
| --------------------------------------------------------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                                                        | api          | `postgresql://…`                                                                                                                                           |
| `REDIS_URL`                                                           | api, workers | `redis://…`                                                                                                                                                |
| `API_HOST`, `API_PORT`                                                | api          | default `0.0.0.0:3001`                                                                                                                                     |
| `WEB_ORIGIN`                                                          | api          | must equal the URL you browse (default `http://localhost:3000`); used for CORS and the CSRF Origin check                                                   |
| `SWAGGER_ENABLED`                                                     | api          | `true`/`false`                                                                                                                                             |
| `TRUST_PROXY_HOPS`                                                    | api          | reverse-proxy hops to trust for client IP (0)                                                                                                              |
| `MONITORING_ALLOW_PRIVATE_NETWORKS`                                   | api, workers | `false` (default) refuses checks against localhost/private/metadata addresses; `true` is an operator opt-in (dev, self-hosting). Keep both processes equal |
| `MONITORING_DISPATCH_INTERVAL_MS`, `MONITORING_RESULT_RETENTION_DAYS` | workers      | defaults `5000` ms and `30` days                                                                                                                           |
| `COOKIE_SECURE`                                                       | api          | session cookie `Secure`; default: production                                                                                                               |
| `SESSION_IDLE_TTL_HOURS`, `SESSION_ABSOLUTE_TTL_DAYS`                 | api          | defaults `168` hours, `30` days                                                                                                                            |
| `AUTH_RATE_LIMIT_MAX`, `AUTH_RATE_LIMIT_WINDOW_SECONDS`               | api          | defaults `10` per `900` s per account                                                                                                                      |
| `API_INTERNAL_URL`                                                    | web          | server-side URL of the API                                                                                                                                 |
| `WORKER_CONCURRENCY`, `WORKER_HEALTH_HOST/_PORT`                      | workers      | defaults `5`, `0.0.0.0:3002`                                                                                                                               |
| `NODE_ENV`, `LOG_LEVEL`                                               | all          |                                                                                                                                                            |
| `POSTGRES_PASSWORD`, `POSTGRES_HOST_PORT`, `REDIS_HOST_PORT`          | compose      | Docker only                                                                                                                                                |

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
pnpm test:e2e                # Playwright; builds, then starts API + web (needs the same services;
                             # first run: pnpm --filter @nexus/e2e exec playwright install chromium)
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
| 2     | Auth, organisations, RBAC                     | Done    |
| 3     | Projects, services, incidents, dashboard      | Done    |
| 4     | Monitoring and workers                        | Done    |
| 5     | GitHub integration                            | Next    |
| 6     | Automation and notifications                  | Planned |
| 7     | Real-time                                     | Planned |
| 8     | Knowledge base and RAG                        | Planned |
| 9     | AI investigation                              | Planned |
| 10    | Security hardening and observability          | Planned |
| 11    | Comprehensive testing                         | Planned |
| 12    | Production polish and demo                    | Planned |

## License

[MIT](LICENSE)
