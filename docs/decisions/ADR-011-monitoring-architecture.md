# ADR-011: Monitoring architecture

**Status:** Accepted (Phase 4). Refines ADR-003 (Redis + BullMQ).

## Context

NEXUS must run HTTP health checks on a schedule, decide when a service is really down (not on one transient failure), open an incident, and record what happened, while staying correct with several worker processes, restarts, retried jobs, and untrusted user-supplied URLs.

## Decisions

1. **The database is the scheduler.** Each check row stores `nextRunAt`. A dispatcher in the worker claims due checks with one statement (`UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED)`), advances `nextRunAt`, and enqueues one BullMQ job per claimed check. _Why not BullMQ repeatable jobs per check?_ They would have to be registered, updated and removed in step with every create, edit, disable, delete and "run now" in the API (two sources of truth that can drift), and would be lost or duplicated in awkward ways across restarts. With `nextRunAt`, all of those operations are one column update; concurrent dispatchers get disjoint sets, so a check runs once per interval however many workers exist; and the database clock is used, so worker clock skew is irrelevant. BullMQ still provides what it is good at: retries, backoff, concurrency limits and observability of the execution itself.
2. **Health state lives on the check row**, not in memory: `consecutiveFailures`, `consecutiveSuccesses`, the verdict and `lastCheckedAt`. The rule that turns results into health (`evaluateCheck`) is a pure function in `packages/shared`, tested exhaustively; the worker only persists what it returns. One failure never marks a service down: a check is DOWN after `failureThreshold` consecutive failures (default 3; 1 is an explicit opt-in) and recovers after `recoveryThreshold` consecutive successes (default 2), which prevents flapping.
3. **Idempotent processing.** Each result is unique per `(check, scheduledFor)`. The dispatcher gives every job a deterministic id derived from the check and the slot, and the processor inserts with `ON CONFLICT DO NOTHING`: a duplicated, retried or concurrent execution of the same slot changes nothing (counters included).
4. **Network I/O outside transactions; all consequences inside one.** The HTTP request runs with no database locks held. The result, counters, service health, incident and timeline are then written in a single transaction under row locks taken in a fixed order (check row, then service row), so workers and API edits cannot interleave or deadlock.
5. **One active monitoring incident per service**, enforced by a partial unique index and by the service-row lock. A repeat failure streak while an incident is still open is recorded on that incident (`MONITORING_SIGNAL`) instead of opening a duplicate. **Recovery never resolves an incident**: it is annotated on the timeline and a human confirms. (Auto-resolution can be added later as an automation rule, Phase 6.)
6. **Shared incident writes.** Incident number allocation and the CREATED event are one function (`createIncidentRecord` in `packages/database`) used by both the API (manual incidents) and the worker (monitoring incidents), so the business rule exists once. Service health aggregation (`recomputeServiceHealth`) is likewise shared between the worker and the API (disabling/deleting a check).
7. **Health = worst of a service's enabled checks**, and `UNKNOWN` ("not monitored") when none has a verdict. Nothing is ever assumed healthy.
8. **SSRF defence in depth** (see `docs/security.md`): URL validation when a check is saved, and again at request time with a custom DNS `lookup` that rejects any non-public address and hands the socket only validated addresses (defeating DNS rebinding). Redirects are never followed and the response body is never read. Private targets are refused by default; `MONITORING_ALLOW_PRIVATE_NETWORKS` is an explicit operator opt-in.
9. **Retention is a queued job.** An hourly `cleanup-results` job (deterministic job id per hour, so several workers create one) deletes results older than `MONITORING_RESULT_RETENTION_DAYS` in batches.
10. **The worker now needs PostgreSQL**, not only Redis; its readiness endpoint checks both.

## Consequences

Correct with multiple workers, restarts and retries, with no scheduler registry to keep in sync. The cost is a polling dispatcher (default every 5 s), so a check can start up to one tick late, and monitoring incident creation is coupled to the database schema in the worker. Not implemented yet, by design: a DEGRADED verdict (slow responses), non-HTTP check types, and multi-region probing.
