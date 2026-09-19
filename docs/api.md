# NEXUS API Design

Status: Phase 0 design. Live OpenAPI docs will be served at `/api/docs` once the API exists.

## Conventions

- Base path `/api/v1`. JSON. Cookie session auth (browser) or `Authorization: Bearer nxs_...` API key.
- The organisation is taken from the session/API key, and appears in paths as `/orgs/:orgId/...` for explicitness; the guard verifies it matches a membership.
- Validation with Zod schemas from `packages/shared`.
- Pagination: cursor-based `?limit=&cursor=`; response `{ data: [], nextCursor }`.
- Idempotency: `Idempotency-Key` header on create endpoints that may be retried by automation.
- Errors (uniform, no stack traces):

```json
{ "error": { "code": "VALIDATION_FAILED", "message": "…", "details": [], "requestId": "…" } }
```

Status codes: 200/201/204, 400 validation, 401 unauthenticated, 403 forbidden (member lacks permission), 404 not found _or not in your org_, 409 conflict/invalid transition, 422 semantic error, 429 rate limited.

## Route map

| Area                                       | Routes                                                                                                                                                                                                                         |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Auth                                       | `POST /auth/register`, `POST /auth/login`, `POST /auth/logout`, `GET /auth/me`                                                                                                                                                 |
| Orgs & members                             | `GET/PATCH /orgs/:orgId`, `GET /orgs/:orgId/members`, `PATCH/DELETE /orgs/:orgId/members/:userId`                                                                                                                              |
| Projects                                   | `GET/POST /orgs/:orgId/projects`, `GET/PATCH/DELETE …/projects/:id`                                                                                                                                                            |
| Services                                   | `GET/POST …/projects/:id/services`, `GET/PATCH/DELETE …/services/:id`, `GET …/services/:id/checks`, `GET …/services/:id/results`                                                                                               |
| Incidents                                  | `GET/POST …/incidents`, `GET/PATCH …/incidents/:id`, `POST …/incidents/:id/transitions`, `GET …/incidents/:id/events`, `POST …/incidents/:id/comments`, `PUT …/incidents/:id/assignees`, `POST …/incidents/:id/investigations` |
| Deployments                                | `GET …/deployments`, `POST …/incidents/:id/deployments`                                                                                                                                                                        |
| Integrations                               | `GET/POST …/integrations/github`, `DELETE …/integrations/github/:id`                                                                                                                                                           |
| Webhooks (public, signature-authenticated) | `POST /webhooks/github/:integrationId`                                                                                                                                                                                         |
| Automations                                | `GET/POST …/automations`, `PATCH/DELETE …/automations/:id`, `GET …/automations/:id/executions`                                                                                                                                 |
| Knowledge                                  | `GET/POST …/knowledge`, `GET/PATCH/DELETE …/knowledge/:id`, `GET …/knowledge/search?q=`                                                                                                                                        |
| Notifications                              | `GET …/notifications`, `POST …/notifications/:id/read`                                                                                                                                                                         |
| Audit                                      | `GET …/audit-logs`                                                                                                                                                                                                             |
| API keys                                   | `GET/POST/DELETE …/api-keys`                                                                                                                                                                                                   |
| Realtime                                   | `GET /orgs/:orgId/events` (SSE)                                                                                                                                                                                                |
| Ops                                        | `GET /health/live`, `GET /health/ready`                                                                                                                                                                                        |

State changes on incidents use `POST …/transitions` with `{ "to": "ACKNOWLEDGED" }` rather than a free `PATCH` on `status`, so the state machine and event recording cannot be bypassed.

---

## Phase 2 as implemented

Paths below are relative to `/api/v1` (health endpoints are unversioned: `/health/live`, `/health/ready`). Browsers reach them through the web app's same-origin proxy at `/api/v1/*`. Interactive docs: `/api/docs` when `SWAGGER_ENABLED=true` (route and tag summaries only; request schemas live in `packages/shared` as Zod).

Authentication is the `nexus_session` cookie. Every state-changing request must carry an `Origin` header equal to `WEB_ORIGIN`.

| Method and path                   | Access                | Notes                                                                                       |
| --------------------------------- | --------------------- | ------------------------------------------------------------------------------------------- |
| `POST /auth/register`             | public, rate limited  | 201 with `{ user, memberships }` and a session cookie. 409 `EMAIL_TAKEN`, 400 validation.   |
| `POST /auth/login`                | public, rate limited  | 200 with `{ user, memberships }`. Uniform 401 `INVALID_CREDENTIALS`. New session each time. |
| `POST /auth/logout`               | authenticated         | 204, revokes the session and clears the cookie.                                             |
| `GET /auth/me`                    | authenticated         | The current user and their memberships (organisation, role).                                |
| `POST /orgs`                      | authenticated         | Creates an organisation; the caller becomes its only OWNER.                                 |
| `GET /orgs`                       | authenticated         | `{ data: [...] }`: only the caller's organisations.                                         |
| `GET /orgs/:orgId`                | `organization.read`   | Organisation plus the caller's role.                                                        |
| `PATCH /orgs/:orgId`              | `organization.update` | Body `{ name }`. The slug is immutable.                                                     |
| `GET /orgs/:orgId/members`        | `users.read`          | `{ data: [...] }`.                                                                          |
| `POST /orgs/:orgId/members`       | `users.manage`        | Body `{ email, role }`; the user must already exist. 404 unknown email, 409 already member. |
| `PATCH /orgs/:orgId/members/:id`  | `users.manage`        | Body `{ role }`. Only an OWNER can grant, change or remove OWNER; 409 `LAST_OWNER`.         |
| `DELETE /orgs/:orgId/members/:id` | `users.manage`        | 204. Same ownership rules.                                                                  |

Status conventions actually in use: **401** no or invalid session; **403** authenticated member lacking the permission (`FORBIDDEN`), an ownership rule (`OWNER_ONLY`), a CSRF origin mismatch, or an undeclared route (`ROUTE_MISCONFIGURED`); **404** unknown resource _or a resource in an organisation you are not a member of_ (identical responses); **409** conflicts (`EMAIL_TAKEN`, `ALREADY_MEMBER`, `LAST_OWNER`); **429** rate limited with `Retry-After`; **503** `RATE_LIMIT_UNAVAILABLE` when the limiter's store is down (fails closed).

---

## Phase 3 routes

All under `/api/v1/orgs/:orgId`. Access is the permission the route declares; requests from non-members are 404.

| Method and path                   | Permission                                                         | Notes                                                                                                                                                                            |
| --------------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /projects`                   | `projects.read`                                                    | `?includeArchived=true`. Includes the count of active services.                                                                                                                  |
| `POST /projects`                  | `projects.manage`                                                  | Body `{ name, description? }`. A unique slug is generated.                                                                                                                       |
| `GET/PATCH /projects/:id`         | `projects.read` / `projects.manage`                                |                                                                                                                                                                                  |
| `DELETE /projects/:id`            | `projects.manage`                                                  | 204. Archives the project and its services (soft delete, idempotent).                                                                                                            |
| `POST /projects/:id/services`     | `services.manage`                                                  | Body `{ name, environment?, description? }`. 409 `SERVICE_EXISTS`, 409 `PROJECT_ARCHIVED`.                                                                                       |
| `GET /services`                   | `projects.read`                                                    | `?projectId=`, `?includeArchived=`.                                                                                                                                              |
| `GET/PATCH/DELETE /services/:id`  | `projects.read` / `services.manage`                                | DELETE archives.                                                                                                                                                                 |
| `GET /incidents`                  | `incidents.read`                                                   | Filters `status` and `severity` (comma lists), `serviceId`, `q` (title, or `42` / `INC-42`), `limit`, `cursor`. Newest first; `nextCursor` is the last incident number returned. |
| `POST /incidents`                 | `incidents.create`                                                 | Body `{ title, severity, description?, serviceId?, tags? }`. 404 if the service is not in this organisation.                                                                     |
| `GET /incidents/:id`              | `incidents.read`                                                   | Includes `allowedTransitions`: what _this caller_ may do next.                                                                                                                   |
| `PATCH /incidents/:id`            | `incidents.update`                                                 | Title, description, severity, tags. Records `SEVERITY_CHANGED` / `UPDATED`; a no-op records nothing.                                                                             |
| `POST /incidents/:id/transitions` | `incidents.update` (plus `incidents.resolve` to resolve or reopen) | Body `{ to, note? }`. 409 `INVALID_TRANSITION`, 409 `STALE_STATE`, 403 without the stronger permission.                                                                          |
| `GET /incidents/:id/events`       | `incidents.read`                                                   | The timeline, oldest first.                                                                                                                                                      |
| `POST /incidents/:id/comments`    | `incidents.update`                                                 | Body `{ body }`. Allowed in any status (post-incident notes).                                                                                                                    |
| `PUT /incidents/:id/assignees`    | `incidents.update`                                                 | Body `{ userIds }` replaces the set. 400 `ASSIGNEE_NOT_MEMBER` if anyone is outside this organisation.                                                                           |
| `GET /dashboard`                  | `incidents.read`                                                   | Active incidents by severity, most urgent list, recent incidents, service health, 14-day trend, activity.                                                                        |

### Incident lifecycle

```text
OPEN → ACKNOWLEDGED → INVESTIGATING → MITIGATED → RESOLVED
```

with shortcuts forward (resolve from ACKNOWLEDGED, INVESTIGATING or MITIGATED), regression MITIGATED → INVESTIGATING, reopening RESOLVED → INVESTIGATING (requires `incidents.resolve`), and cancellation from any unresolved state. `CANCELLED` is terminal. The rule table lives once in `packages/shared/src/incidents.ts`, is tested exhaustively (all 36 status pairs), is enforced by the API on every transition, and is only _used_ by the web app to decide which buttons to show. Two simultaneous transitions cannot both succeed: the update is applied with `WHERE status = <status we validated against>`.

Every change writes an `IncidentEvent` in the same transaction as the change. Event types so far: `CREATED`, `UPDATED`, `STATUS_CHANGED`, `SEVERITY_CHANGED`, `ASSIGNED`, `UNASSIGNED`, `COMMENT_ADDED`, `MONITORING_SIGNAL`, `DEPLOYMENT_LINKED`. Automation and AI events are added by the phases that create them.

---

## Phase 4 routes (monitoring)

All under `/api/v1/orgs/:orgId`.

| Method and path             | Permission        | Notes                                                                                                                                                                                                                                                            |
| --------------------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /services/:id/checks`  | `projects.read`   | A service's checks with their current state.                                                                                                                                                                                                                     |
| `POST /services/:id/checks` | `services.manage` | Body `{ name, url, expectedStatus?, timeoutMs?, intervalSeconds?, failureThreshold?, recoveryThreshold?, incidentSeverity?, createIncidents?, enabled? }`. 400 `URL_NOT_ALLOWED` for unsafe URLs, 409 `CHECK_LIMIT` (max 5 per service), 409 `SERVICE_ARCHIVED`. |
| `GET /checks/:id`           | `projects.read`   |                                                                                                                                                                                                                                                                  |
| `PATCH /checks/:id`         | `services.manage` | Changing the URL or expected status resets the verdict and counters (the old verdict was about a different target). Enabling/disabling recomputes service health.                                                                                                |
| `DELETE /checks/:id`        | `services.manage` | 204. Deletes its results and recomputes service health.                                                                                                                                                                                                          |
| `POST /checks/:id/run`      | `services.manage` | **202** `{ status: "scheduled" }`. Sets `nextRunAt = now`; the dispatcher runs it on its next tick. 409 `CHECK_DISABLED`.                                                                                                                                        |
| `GET /checks/:id/results`   | `projects.read`   | Newest first. `?limit=` (1-200, default 50) and `?before=<ISO timestamp>`; response has `nextBefore` for the next page.                                                                                                                                          |

Service responses now include `healthStatus` and `healthChangedAt`. Incidents created by monitoring have `source: "MONITORING"`, no `createdBy`, and `SYSTEM` actor events.

---

## Phase 5 routes (GitHub integration)

Under `/api/v1/orgs/:orgId` unless stated. Integrations need `INTEGRATION_ENCRYPTION_KEY`; without it creating one returns 503 `INTEGRATIONS_NOT_CONFIGURED`.

| Method and path                               | Permission            | Notes                                                                                                                                                                                                                                |
| --------------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /integrations/github`                    | `projects.read`       | Active integrations. Never includes a secret.                                                                                                                                                                                        |
| `POST /integrations/github`                   | `integrations.manage` | Body `{ repoFullName, projectId, serviceId? }`. **201** with `webhookPath` and `webhookSecret`: the only time the secret is ever returned. 404 for a project or service outside the organization, 409 `INTEGRATION_EXISTS`.          |
| `DELETE /integrations/github/:id`             | `integrations.manage` | 204. Disables it (history is kept); 404 if already disabled.                                                                                                                                                                         |
| `GET /deployments`                            | `projects.read`       | Newest first. `?serviceId=` and `?limit=` (1-100, default 25).                                                                                                                                                                       |
| `GET /incidents/:id/deployments`              | `incidents.read`      | `{ linked, suggested }`. Suggestions are successful deployments to the incident's service in the 120 minutes before it began, not yet linked (at most 5).                                                                            |
| `POST /incidents/:id/deployments`             | `incidents.update`    | Body `{ deploymentId, relation?: "SUSPECTED" \| "CONFIRMED" }` (default `SUSPECTED`). **201**. Writes a `DEPLOYMENT_LINKED` timeline event in the same transaction. 404 for another organization's deployment, 409 `ALREADY_LINKED`. |
| `POST /api/v1/webhooks/github/:integrationId` | none (signature)      | See below. **202** `{ status: "accepted" \| "duplicate" \| "ignored" }`.                                                                                                                                                             |

### The webhook endpoint

Configure GitHub with the payload URL, content type `application/json`, the secret, and the **Deployment statuses** event. Authentication is `X-Hub-Signature-256`: an HMAC-SHA256 of the raw body keyed with the integration's secret.

| Response | Meaning                                                                                                                                           |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 202      | `accepted` (stored and queued), `duplicate` (this delivery id was already received), or `ignored` (an event type NEXUS does not use; not stored). |
| 400      | Signed, but not `application/json`, or the delivery/event headers are missing or malformed.                                                       |
| 401      | Missing or invalid signature. Nothing is stored.                                                                                                  |
| 404      | Unknown or disabled integration (the two are indistinguishable).                                                                                  |
| 429      | Too many requests from this address, or too many bad signatures for this integration from this address.                                           |
| 503      | Integrations are not configured, or the queue is unavailable (nothing was kept, so GitHub's redelivery is processed).                             |
