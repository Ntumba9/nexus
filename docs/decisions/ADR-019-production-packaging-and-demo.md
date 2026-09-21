# ADR-019: Production packaging and the demo

**Status:** Accepted (Phase 12). Records how NEXUS is meant to be deployed, what was verified and how, what was deliberately not done, and how the demo data is made.

## Context

By Phase 11 the code was built, secured and tested, but nobody had run it the way a stranger would: a fresh machine, a real domain, HTTPS, an empty database. The Dockerfiles had been written when Docker was unavailable and had never been built. The containers running on the author's machine turned out to be an image from before Phase 8, so they lacked whole features. Phase 12 built the images from current source, ran them from scratch under a production configuration, and fixed what that showed.

## Decisions

1. **A production overlay, `docker-compose.prod.yml`, on top of the base file.** It publishes only Caddy's ports (80 and 443). PostgreSQL, Redis, the API and the web app get no host ports. Caddy terminates TLS and renews its certificate by itself, so the session cookie can be `Secure` and HSTS can be sent. `WEB_ORIGIN`, `SITE_ADDRESS` and `POSTGRES_PASSWORD` have no defaults there, so a missing one stops startup instead of running with a weak or wrong value. Swagger is off. `TRUST_PROXY_HOPS` is 1: Caddy overwrites `X-Forwarded-For` with the real client address, the web app forwards it unchanged, and the API trusts exactly the one hop, so the client address is correct and cannot be spoofed. Caddy over nginx or Traefik because it needs no certificate tooling and its whole configuration here is five lines (`deploy/Caddyfile`).
2. **Optional settings now reach the containers.** The compose file passed through only some variables. The AI, embedding, metrics-token, rate-limit and retention settings, all documented in the README, were silently ignored in Docker. They are now passed as bare names, which forwards a variable only when it is set. An empty value is not an option: the configuration correctly rejects an empty `EMBEDDING_API_URL`.
3. **Demo data is created through the public API (`pnpm demo`).** The script registers four accounts, creates an organization with a project, services, runbooks, two automation rules and four incidents at different stages, all through the same endpoints a person uses, so validation, permissions, audit entries, notifications and runbook suggestions behave exactly as they do for real. It writes nothing to the database directly. Because it creates accounts with a **known password**, it refuses any API that is not on localhost unless `--allow-remote` is passed, and the deployment guide says never to run it on a real installation. It signs in before registering and skips every step that is already done, so a run that stopped halfway can be repeated and a second run creates nothing.
4. **A deployment guide, `docs/deployment.md`,** covering first deployment, upgrades, backup and restore, monitoring, and troubleshooting. Every command in it was run, not just written (below).
5. **The images were not slimmed. This is a decision, not an omission.** They are 1.2 to 1.3 GB each (api 1.32, web 1.31, worker 1.21). The Dockerfiles are single-stage and keep the built workspace, including development dependencies and the Prisma CLI, which the one-shot `migrate` service needs. A multi-stage image built with `pnpm deploy --prod` would probably halve them, but each obvious route has a real hazard here: the generated Prisma client lives inside pnpm's virtual store and is not part of what `deploy` copies; the native Argon2 binary must come along; the `migrate` service needs the Prisma CLI that a production install drops, so it would need its own image and a fourth entry in the CI publishing matrix; and Next's standalone output has to be verified against the CSP proxy. Each of those fails only at run time, and each experiment costs a 15-minute build on a slow machine. The current images work, run as the unprivileged `node` user, and were verified end to end. Size costs disk and pull time, not correctness or security. If image size starts to matter, the sketch above is the starting point.

## What was verified, and how

Built all three images from current source and started the stack twice: once as the ordinary development stack, and once as a completely separate compose project with the production overlay, an empty database and Redis, and `SITE_ADDRESS=localhost` (so Caddy issued a certificate from its own local authority). On that second stack:

- Migrations applied from an empty database; every service became healthy; only Caddy published ports.
- HTTPS worked through Caddy with HTTP redirecting to HTTPS; the responses carried HSTS and the per-request CSP nonce; the session cookie was `HttpOnly; Secure; SameSite=Lax`.
- The live-update stream (Server-Sent Events) arrived immediately through Caddy, and its keep-alive heartbeat kept arriving, so it is not buffered.
- `pnpm demo` seeded the whole demo from nothing, over HTTPS. On the development stack it resumed a run that had failed halfway, and repeating it created nothing. The automation rules produced notifications and the checkout incident suggested the checkout runbook.
- The guide's `pg_dump` and `pg_restore` commands produced a dump that restored into a fresh database with matching row counts for incidents, runbook documents, users and audit entries.

## Not verified, and known gaps

- **A real Let's Encrypt certificate** on a public domain. The overlay, Caddy configuration and its validation were checked, but the certificate came from Caddy's local authority. The guide's troubleshooting section covers the usual causes of failure.
- **Real SMTP delivery, and real GitHub webhooks,** need accounts and a public address. Both are covered by integration tests against fakes, not against the real services.
- **Automated backups.** The guide gives the commands and says to schedule and test them, but nothing schedules them.
- **High availability, scaling beyond one machine, image vulnerability scanning and signing,** and a software bill of materials. The CI dependency audit covers the packages, not the base images.
- **Registration is open** to anyone who can reach the site (no email verification exists, ADR-017). The guide says to restrict access at the network level for a private instance.

## Consequences

- Someone can follow `docs/deployment.md` on a fresh machine and reach a working, HTTPS-only instance, and can populate it with `pnpm demo` to try it.
- A misconfigured production start fails loudly on the three required values instead of running insecurely.
- The images stay large. The trade is recorded above so it can be revisited with the risks in view.
