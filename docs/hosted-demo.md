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

The order matters: the API needs the web app's URL, and seeding needs the API.

### 1. Neon (you)

1. Create a project at neon.tech. Pick the region closest to your Render region.
2. Copy the **connection string** (it starts with `postgresql://` and contains a password). Treat it like a password: paste it only into Render and into your own terminal.
3. Apply the database migrations from your machine, once (this also creates the extensions):

   ```bash
   DATABASE_URL='<your Neon connection string>' pnpm db:migrate:deploy
   ```

### 2. Vercel: the web app

Project settings (these are also in `apps/web/vercel.json`):

- **Root Directory:** `apps/web`, with "Include source files outside of the Root Directory" on.
- **Node.js version:** 22.x.
- **Environment variables** (Production):

  | Variable                                  | Value                                                       |
  | ----------------------------------------- | ----------------------------------------------------------- |
  | `API_INTERNAL_URL`                        | The Render API's URL, `https://nexus-api-….onrender.com`    |
  | `REGISTRATION_ENABLED`                    | `false`                                                     |
  | `DEMO_LOGIN_EMAIL`, `DEMO_LOGIN_PASSWORD` | The viewer's email and password. Shown on the sign-in page. |

The first deploy can happen before the API exists, to learn the URL; the site will load but sign-in will fail until step 3 is done.

### 3. Render: the API, the worker and Redis

1. In Render, choose **New, Blueprint**, and point it at this repository. It reads `render.yaml` and creates the API, the worker and the Key Value store.
2. It asks for the values marked `sync: false`:

   | Variable                     | Value                                                                                                 |
   | ---------------------------- | ----------------------------------------------------------------------------------------------------- |
   | `DATABASE_URL`               | Your Neon connection string                                                                           |
   | `WEB_ORIGIN`                 | Your Vercel URL, exactly as it appears in the browser: `https://<name>.vercel.app`, no trailing slash |
   | `INTEGRATION_ENCRYPTION_KEY` | `openssl rand -base64 32`. Keep a copy somewhere safe                                                 |

3. When the API is live, `https://<api>.onrender.com/health/ready` should say both PostgreSQL and Redis are up.
4. Put the API's URL into Vercel's `API_INTERNAL_URL` and redeploy the web app.

### 4. Seed the demo data

The script registers the demo accounts, so sign-up must still be open on the API when it runs. `render.yaml` starts with `REGISTRATION_ENABLED=true` for exactly this reason. Keep the site's URL to yourself until step 5.

```bash
API_URL='https://<api>.onrender.com' \
WEB_ORIGIN='https://<name>.vercel.app' \
DEMO_PRIVATE_PASSWORD='<a long password only you know>' \
pnpm demo --allow-remote
```

`--allow-remote` is the script's safety catch: it creates accounts with known passwords, so it refuses anything but localhost without it. On a public demo that is what you intend, and `DEMO_PRIVATE_PASSWORD` is what keeps the published viewer password from opening the accounts that can write. The script prints which login is safe to publish.

### 5. Close sign-up and check

**This step is not optional.** Set `REGISTRATION_ENABLED=false` on the API in Render and let it redeploy. Then, in a private browser window:

- The sign-in page shows the demo login, and no "Create an account" link.
- Signing in as the viewer shows the dashboard, incidents and runbooks.
- Creating anything as the viewer is refused.
- `POST /api/v1/auth/register` against the API answers 403 `REGISTRATION_DISABLED`.

## What was and was not verified

- **Verified:** the sign-up switch (API refusal, web hiding, existing accounts still sign in), the demo script's split passwords, and everything in the single-machine Docker setup that this reuses.
- **Not verified:** `render.yaml` and the Vercel settings were written without accounts to apply them to, and nothing here has run on Vercel, Render or Neon. The most likely trouble spots are the Render blueprint's field names, the Vercel monorepo build (which builds the workspace packages first), and the proxy hop count. Treat the first deployment as a test and expect small fixes.
