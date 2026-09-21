# A public demo: Vercel + Render + Neon

This puts NEXUS on the internet so people can try it from a link. It is a different setup from [docs/deployment.md](deployment.md), which runs everything on one machine with Docker. Use this one for a portfolio demo, that one for a real installation.

NEXUS is four things, and Vercel only hosts one of them:

| Part                             | Runs on                      | Why                                                                  |
| -------------------------------- | ---------------------------- | -------------------------------------------------------------------- |
| Web app (Next.js)                | **Vercel**                   | It is a Next.js app; this is what Vercel is for                      |
| API (NestJS)                     | **Render** web service       | A long-running server. Vercel runs short serverless functions        |
| Background worker                | **Render** background worker | Runs checks, automation, email and AI jobs continuously              |
| Job queue (Redis)                | **Render** Key Value (free)  | BullMQ needs a real Redis, with no eviction                          |
| Database (PostgreSQL + pgvector) | **Neon**                     | Free tier, supports the `vector` and `citext` extensions NEXUS needs |

## What it costs and what to expect

- **Vercel and Neon: free.** **Render: about $14 a month** (two Starter instances; the Key Value store is free). Render's free web service sleeps after 15 minutes and takes about a minute to wake, which is a bad first impression on a link people click once, and it has no free worker. Without a running worker the sample data still browses fine, but monitoring, automation, email and AI jobs do nothing.
- **Live updates reconnect about once a minute.** A Vercel function has a time limit, so the real-time stream is re-opened periodically. You will not notice it.
- **Client IPs for rate limiting are approximate.** Two proxies sit in front of the API (Vercel, then Render), so `TRUST_PROXY_HOPS` is 2. Per-account limits, the stricter ones, do not depend on it.

## Before the demo is public: decide who can do what

Every visitor sees the demo login, so that account must not be able to hurt anything.

- The public login is the **read-only viewer** (`viewer@demo.example.com`). It can browse the dashboard, incidents, services, runbooks and the AI investigations the demo seeds. Every change is refused (checked: creating, commenting, moving, editing and deleting all answer 403), and it cannot see the audit log or automation rules. It cannot start an AI investigation, which is why the seed script runs two for it.
- The **owner, developer and support** accounts can change data. Give them a private password (`DEMO_PRIVATE_PASSWORD`, below) so the published one does not open them. Use the owner account yourself when you want to show writing features.
- **Sign-up is closed** (`REGISTRATION_ENABLED=false`), so strangers cannot create accounts. There is no email verification or MFA, so open sign-up on the public internet would fill the database with junk.

## Steps

The order matters. The database is seeded on your own machine **before** the API goes online, so sign-up never has to be open on the internet, and Render's API starts with it closed.

### 1. Neon: the database, and the demo data

1. Create a project at neon.tech (or `npx neonctl auth`, then `neonctl projects create`). Pick the region nearest your Render region; Frankfurt pairs with Render's Frankfurt.
2. Get the **direct** connection string (in the console's Connect dialog, turn connection pooling **off**; the pooled string does not suit Prisma migrations). It starts with `postgresql://` and contains a password, so treat it like one: paste it only into Render and into your own terminal.
3. Apply the migrations once. This also creates the `vector` and `citext` extensions:

   ```bash
   DATABASE_URL='<your Neon connection string>' pnpm db:migrate:deploy
   ```

4. Seed the demo data. Run the API and the worker on your machine against the Neon database, with sign-up open **locally only**, then run the seed script against your local API. The worker matters: the two seeded AI investigations are finished by it.

   ```bash
   export DATABASE_URL='<your Neon connection string>' REDIS_URL=redis://localhost:6379/2      API_PORT=3058 WEB_ORIGIN=http://localhost:3000 REGISTRATION_ENABLED=true NODE_ENV=development
   pnpm --filter "./packages/*" build && pnpm --filter @nexus/api build && pnpm --filter @nexus/workers build
   node apps/api/dist/main.js &
   WORKER_HEALTH_PORT=3059 node workers/dist/main.js &
   API_URL=http://localhost:3058 DEMO_PRIVATE_PASSWORD='<a long password only you know>' pnpm demo
   ```

   Then stop both processes. `DEMO_PRIVATE_PASSWORD` is what keeps the published viewer password from opening the accounts that can write; the script prints which login is safe to publish. This needs a local Redis; `docker compose up -d redis` provides one.

### 2. Render: the API, the worker and Redis

1. In Render, choose **New, Blueprint**, and point it at this repository. It reads `render.yaml` and creates the API, the worker and the Key Value store.
2. It asks for the values marked `sync: false`:

   | Variable                     | Value                                                                                                 |
   | ---------------------------- | ----------------------------------------------------------------------------------------------------- |
   | `DATABASE_URL`               | Your Neon direct connection string                                                                    |
   | `WEB_ORIGIN`                 | Your Vercel URL, exactly as it appears in the browser: `https://<name>.vercel.app`, no trailing slash |
   | `INTEGRATION_ENCRYPTION_KEY` | `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`. Keep a copy            |

3. When the API is live, `https://<api>.onrender.com/health/ready` should say both PostgreSQL and Redis are up.

### 3. Vercel: the web app

Project settings (Root Directory `apps/web`; the build commands are in `apps/web/vercel.json`). Environment variables (Production):

| Variable                                  | Value                                                       |
| ----------------------------------------- | ----------------------------------------------------------- |
| `API_INTERNAL_URL`                        | The Render API's URL, `https://nexus-api-….onrender.com`    |
| `REGISTRATION_ENABLED`                    | `false`                                                     |
| `DEMO_LOGIN_EMAIL`, `DEMO_LOGIN_PASSWORD` | The viewer's email and password. Shown on the sign-in page. |

Until `API_INTERNAL_URL` points at a running API, the site shows its "backend is offline" page. Redeploy after setting it.

### 4. Check it, in a private browser window

- The sign-in page shows the demo login, and no "Create an account" link.
- Signing in as the viewer shows the dashboard, incidents, runbooks and the two AI investigations.
- Creating anything as the viewer is refused.
- `POST /api/v1/auth/register` against the API answers 403 `REGISTRATION_DISABLED`.

## What was and was not verified

- **Verified on a real Neon project (PostgreSQL 18, Frankfurt):** all migrations apply and create the `vector` and `citext` extensions; the API and worker run against it; the seed script populates it, including both AI investigations; the published password opens only the read-only viewer (the owner and developer accounts refuse it); the sign-up switch, and everything in the single-machine Docker setup that this reuses.
- **Not verified:** `render.yaml` has not been applied to a Render account, and the Vercel-to-Render connection (including the proxy hop count) has not run. The most likely trouble spots are the Render blueprint's field names and that hop count. Treat the first Render deployment as a test and expect small fixes.
