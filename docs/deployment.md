# Deploying NEXUS

This is the guide for running NEXUS on one Linux machine with Docker Compose, in front of a real domain with HTTPS. For a local trial, the README's quick start is enough.

## What you need

- A machine with Docker (Compose v2.24 or newer) and about 2 GB of RAM to spare. The images are large (about 1.2 GB each; see ADR-019 for why).
- A domain name whose DNS points at the machine, and ports **80 and 443** open to the internet. Caddy needs both to obtain and renew its certificate.
- Somewhere to keep backups that is not the same machine.

## First deployment

1. **Get the code and create `.env`.**

   ```bash
   git clone https://github.com/Ntumba9/nexus.git && cd nexus
   cp .env.example .env
   ```

2. **Set the values that matter in `.env`.** The production overlay refuses to start without the first three.

   | Variable                                    | What to put                                                                                                       |
   | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
   | `POSTGRES_PASSWORD`                         | A long random password (`openssl rand -hex 24`). It is not exposed outside the compose network.                   |
   | `WEB_ORIGIN`                                | The public URL, exactly as people type it: `https://nexus.example.com`. CORS, CSRF checks and email links use it. |
   | `SITE_ADDRESS`                              | The host name alone: `nexus.example.com`.                                                                         |
   | `INTEGRATION_ENCRYPTION_KEY`                | `openssl rand -base64 32`. Needed for GitHub integrations and outbound webhooks. **Back it up** (see below).      |
   | `METRICS_TOKEN`                             | Optional. `openssl rand -hex 24` enables `GET /metrics` behind that bearer token.                                 |
   | `EMAIL_TRANSPORT`, `SMTP_URL`, `EMAIL_FROM` | `smtp` and a real SMTP URL, or password-reset and notification emails only go to the worker log.                  |

   Everything else has a safe default. The full list is in the README's environment table.

3. **Start it.**

   ```bash
   docker compose -f docker-compose.yml -f docker-compose.prod.yml --profile app up -d
   ```

   The database migrations run first, as a one-shot `migrate` service, and the API and worker wait for them. Caddy gets its certificate the first time someone visits the site; the first request can take a few seconds.

4. **Check that it is healthy.**

   ```bash
   docker compose -f docker-compose.yml -f docker-compose.prod.yml --profile app ps
   curl -fsS https://nexus.example.com/health
   ```

5. **Create the first account.** Open the site and register. Whoever registers can create their own organization, and registration is open to anyone who can reach the site. If the instance is meant to be private, restrict access at the network level (a VPN, or Caddy's `basicauth` or an IP allow-list) until email verification exists.

The overlay `docker-compose.prod.yml` publishes only Caddy's ports. PostgreSQL, Redis, the API and the web app are reachable only from inside the compose network.

## Upgrading

```bash
git pull
docker compose -f docker-compose.yml -f docker-compose.prod.yml --profile app up -d --build
```

Or, to use the images CI publishes instead of building on the machine, set `NEXUS_IMAGE_TAG` in `.env` to a commit SHA and run `pull` and `up -d`. Migrations run automatically before the new API and worker start. **Take a backup first**: migrations are forward-only.

## Backups

The database holds everything that matters. Redis holds only queued work, and compose keeps it on a persistent volume, so a restart loses nothing. Health checks are scheduled from the database and automation events are read from it, so both carry on if Redis is ever wiped. Jobs that exist only in Redis (a GitHub delivery waiting to be processed, a document being embedded, an investigation) would be lost; GitHub can redeliver, and the others can be run again. That is why Redis does not need backing up.

Back up the database:

```bash
docker compose exec -T postgres pg_dump -U nexus -d nexus --format=custom > nexus-$(date +%F).dump
```

Restore into an empty database (on a new machine, after `up -d postgres` and before starting the app):

```bash
docker compose exec -T postgres pg_restore -U nexus -d nexus --no-owner --clean --if-exists < nexus-2026-01-01.dump
```

Also keep, somewhere separate from the dump:

- **`INTEGRATION_ENCRYPTION_KEY`.** Without it, stored GitHub webhook secrets and outbound webhook signing secrets in a restored database cannot be decrypted, and those integrations must be recreated. Nothing else depends on it.
- Your `.env` file.

Automate the dump (cron or a systemd timer), copy it off the machine, and **test a restore** on a scratch machine at least once. A backup that has never been restored is a hope, not a backup.

## Watching it

- **Health:** `GET /health` on the site (the web app), `/health/live` and `/health/ready` on the API and worker containers. Compose already uses them for its own health checks and restarts.
- **Metrics:** with `METRICS_TOKEN` set, the API and the worker serve Prometheus text at `/metrics` with `Authorization: Bearer <token>`. They are not published outside the compose network; scrape them from a Prometheus that joins it, or add a Caddy route restricted to your scraper's address.
- **Logs:** structured JSON, one line per event, on each container's stdout: `docker compose logs -f api worker`. A request id ties an API request to the worker jobs it caused.
- **Audit log:** in the app, under "Audit Log" in the navigation (visible to roles with the audit permission).

## Choices you may want to change

- **Monitoring private targets.** By default the worker refuses to probe localhost, private networks and cloud metadata addresses. Set `MONITORING_ALLOW_PRIVATE_NETWORKS=true` on **both** the API and the worker only if you deliberately want to watch internal services, and understand that it lets any organization member with the right role point checks at your internal network.
- **AI investigation and semantic search.** Both work with no account or key. To use a real model, set `AI_PROVIDER=openai` with an OpenAI-compatible endpoint, and likewise `EMBEDDING_PROVIDER=openai` (a 384-dimension model). See the README table.
- **Rate limits.** `API_RATE_LIMIT_PER_MINUTE` (per client IP, default 1200) is a backstop. The login and password endpoints have their own much stricter limits.

## Troubleshooting

- **Caddy cannot get a certificate.** The domain must resolve to this machine and ports 80 and 443 must be reachable from outside. `docker compose logs caddy` says which step failed. Use a staging CA while testing to avoid Let's Encrypt rate limits.
- **You can load the site but signing in fails or loops.** `WEB_ORIGIN` must match the address in the browser exactly, including `https://` and no trailing slash. The API rejects state-changing requests from any other origin.
- **A service shows unhealthy.** `docker compose logs <service>`. A configuration error stops the process with a message naming the variable, never its value.
- **Emails never arrive.** With `EMAIL_TRANSPORT=log` (the default) they are written to the worker's log instead of sent. Set `smtp` and `SMTP_URL`.
- **Everyone appears to come from one address (rate limits hit too early).** `TRUST_PROXY_HOPS` must be `1` behind Caddy; the overlay sets it. If you put another proxy in front of Caddy, it must be raised to match, and that proxy must overwrite `X-Forwarded-For`.

## Demo data

To put a public demo on the internet (Vercel, Render and Neon) instead of running everything on one machine, see [hosted-demo.md](hosted-demo.md).

`pnpm demo` fills a running instance with a sample organization, including accounts with a **known password**. It refuses to run against anything but localhost. Never run it on a real deployment.
