# ADR-006: AI context isolation and provider boundaries

**Status:** Accepted

## Context

The AI reads incident data and knowledge documents, some attacker-influenceable, across a multi-tenant system.

## Problem

Prevent cross-tenant retrieval, prompt injection escalation, and unverifiable claims.

## Options considered

1. Give the model tools (search, actions): powerful, but injection could reach actions and data.
2. Single prompt with raw dumps: unbounded, unverifiable.
3. Backend-assembled, labelled, bounded context; no tools; verified citations.

## Decision

Option 3. Org ID derives from the session; retrieval APIs require it. Sources are labelled; output is Zod-validated; unknown citations are dropped; evidence vs inference is explicit; the model cannot trigger actions. Embeddings sit behind a provider interface because Anthropic offers no first-party embeddings endpoint; dev/test uses a deterministic local provider with full-text fallback.

## Consequences

Less "agentic" but far safer and auditable. Storing the context snapshot enlarges rows but makes citations inspectable.
