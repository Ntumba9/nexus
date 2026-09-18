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
