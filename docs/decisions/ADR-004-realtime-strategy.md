# ADR-004: Server-Sent Events for real-time updates

**Status:** Accepted

## Context

Dashboards and incident pages need live updates: incident changes, service health, automation results, notifications.

## Problem

Pick WebSockets or SSE.

## Options considered

1. WebSockets: bidirectional, but we have no client→server realtime need; more proxy/auth complexity.
2. Polling: simple but wasteful and laggy.
3. SSE: one-way, plain HTTP, cookie auth, built-in reconnect.

## Decision

SSE, one stream per organisation, fan-out through Redis pub/sub so multiple API instances work. Events carry IDs and minimal data; clients invalidate TanStack Query caches and refetch (so authorization stays in the REST layer). Heartbeats every 15s.

## Consequences

No client→server channel (not needed; REST covers it). Must configure proxies not to buffer. Per-browser connection limit under HTTP/1.1 is avoided by one stream per tab.
