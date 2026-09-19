# ADR-014: Real-time updates, as built

**Status:** Accepted (Phase 7). Implements ADR-004 (Server-Sent Events, Redis pub/sub) and `docs/architecture.md` §4.

## Context

Until now every screen polled. An incident that opened, a service that went down or a notification that arrived showed up up to 30 seconds late, and every open tab kept asking whether anything had changed. ADR-004 chose the transport; this records how it was built and the rules that keep it safe.

## Decisions

1. **A message is a signal, not data.** It is `{ topic, userId? }`: "something of this kind changed in this organisation". It carries no incident title, no service name, no record. The browser reacts by refetching through the REST API, so authorization, filtering and pagination stay in exactly one place and the stream can never reveal more than a refetch would. Topics are a closed list in `packages/shared` (`incidents`, `projects`, `services`, `monitoring`, `deployments`, `integrations`, `automation`, `notifications`, `members`, `organization`).
2. **One Redis channel per organisation** (`nexus:rt:<orgId>`). Each API instance keeps ONE subscriber connection (a pattern subscription) and hands messages to the streams open on that instance, so any number of API instances and workers reach the same browsers. Malformed messages and channels that are not an organisation are ignored.
3. **Two producers, both after the change is committed.**
   - _The API_, for anything a person does: a global interceptor publishes after any successful state-changing request under `/orgs/:orgId/…`, deriving the topics from the path. It lives in one place so no controller can forget. It fires and forgets: it never delays or fails the response.
   - _The worker_, for anything a person did not do: the automation dispatcher announces every domain event it claims (incident, service health and deployment changes come from the transactional outbox of ADR-013, so one chokepoint covers every source, including changes made by the API itself); the health-check processor announces recorded results; the webhook processor announces processed deployments; the automation executor announces a finished run and tells each notified person, individually, that their inbox changed.
4. **Best-effort by construction.** A signal never fails the work that caused it: publishing swallows errors, and the worker uses its own fail-fast Redis connection (no offline queue) so an unreachable Redis cannot stall a job. The cost of a lost signal is bounded: the browser keeps a slow safety-net poll (60 s while connected, its old rate while not), and on every reconnect it refetches everything for the organisation.
5. **Access is checked when the stream opens, per message, and continuously.**
   - _Opening:_ the same global guards as any route (session, then membership; a non-member gets the same 404 as for an organisation that does not exist).
   - _Per message:_ each topic requires the permission the matching REST reads need (`TOPIC_PERMISSION`), so a member is not even hinted at activity in areas they cannot read (a VIEWER never hears that automation changed). Notification signals carry the recipient's id and reach only that person's streams.
   - _Continuously:_ every heartbeat (`REALTIME_HEARTBEAT_MS`, default 15 s) re-reads the member's role and session from the database. A removed member, a disabled user, a logout or an expired session ends the stream within one heartbeat; a changed role takes effect at once for later messages.
6. **Bounded.** At most 10 open streams per user per API instance (429 beyond that); a tab holds one. The heartbeat is a comment line so proxies do not close an idle connection; the response sets `Cache-Control: no-cache, no-transform` and `X-Accel-Buffering: no`.
7. **The web proxy must not cut the stream.** The same-origin proxy that fronts the API gave every request a 15 s deadline. The stream route is recognised (`GET /orgs/:orgId/events`) and instead lives as long as the browser connection, which aborts the upstream request when the tab goes away.
8. **The client is one provider.** `RealtimeProvider` (mounted once in the organisation shell) opens an `EventSource`, batches signals arriving within 150 ms, and invalidates the TanStack Query keys the topic makes stale (`queryKeysForTopic`). Components did not change how they fetch; their `refetchInterval` became `pollEvery(ms)`, which slows to a safety net while the stream is connected. If `EventSource` is unavailable, or the stream is refused, the app behaves exactly as it did in Phase 6. A small "Live / Polling" indicator shows which mode it is in.

## Consequences

Updates arrive in well under a second for actions through the API, and within the dispatcher interval (default 1 s) for changes made by workers. Every browser tab holds one long-lived connection, so a deployment behind a reverse proxy must not buffer or time out idle streams shorter than the heartbeat (documented in the README). Because signals carry no data, a client that missed one is repaired by any refetch; there is no per-client replay log to maintain. Not built, by design: WebSockets or any client-to-server channel, `Last-Event-ID` replay, presence ("who is viewing this incident") and typing indicators.
