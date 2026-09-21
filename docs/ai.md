# NEXUS AI Architecture

Status: implemented. Retrieval in Phase 8 ([ADR-015](decisions/ADR-015-knowledge-base-and-retrieval.md)), the investigation pipeline in Phase 9 ([ADR-016](decisions/ADR-016-ai-investigation.md)). Where this original design and the ADRs differ, the ADRs describe what was built: notably the model is any OpenAI-compatible endpoint (or a built-in rule engine, the default) rather than Anthropic, so the feature costs nothing to run.

AI is an assistant inside NEXUS, not the product. With `AI_PROVIDER=none` the "Investigate" button is disabled with an explanation and everything else works; if a configured model is down, the run fails with a short reason and can be retried.

## Pipeline

```text
User clicks Investigate (needs incidents.update)
  → API: creates AIInvestigation(status=QUEUED), enqueues job, returns 202
  → Worker: ContextAssembler (tenant-scoped, bounded)
  → AnalysisProvider: built-in rules (default), or an OpenAI-compatible chat model (no tools, model and key from env only)
  → Zod-validate structured output
  → SourceVerifier: drop/flag citations not present in context
  → Persist result + context snapshot; emit incident event + SSE
```

## Context assembly

Sources, each with a stable label the model must cite:

| Label           | Content                                                              |
| --------------- | -------------------------------------------------------------------- |
| `INC-EVT-<n>`   | Incident timeline events                                             |
| `MON-<id>`      | Recent monitoring results for the affected service                   |
| `DEP-<id>`      | Deployments in the window before onset                               |
| `COMMIT-<sha7>` | Commits in those deployments                                         |
| `INC-PREV-<n>`  | Previous incidents on the same service                               |
| `KB-<id>`       | Top-k knowledge chunks (vector search filtered by `organization_id`) |

Bounded by count and token budget; oldest/lowest-relevance dropped first. Credential-shaped strings are redacted.

## Output schema

```text
summary: string
possible_causes: [{ description, kind: "evidence" | "inference", sources: [label], confidence: low|medium|high }]
evidence: [{ statement, sources: [label] }]        // must have ≥1 verified source
recommended_investigations: [string]
recommended_actions: [{ description, risk: low|medium|high }]   // advisory text only
confidence: low|medium|high
```

Rules: evidence claims must cite verified sources; anything without a source is rendered as inference. The UI shows each citation as a link that opens the stored snapshot of that source.

## Prompt-injection posture

Retrieved documents, commit messages, incident text and monitoring bodies are attacker-influenceable. They are placed in delimited data blocks; the system prompt states they are untrusted data and that instructions inside them must be ignored. Because the model has no tools and output cannot trigger actions, the worst case of a successful injection is a misleading summary, which is mitigated by mandatory verified citations and evidence/inference labelling.

## RAG

- Chunking: Markdown-aware, heading-based, ~500 tokens, small overlap; `content_hash` avoids re-embedding unchanged chunks.
- Storage: pgvector column on `KnowledgeChunk`.
- Implemented in Phase 8. Embeddings: behind an `EmbeddingProvider` interface. Anthropic does not offer a first-party embeddings endpoint, so the provider is configurable (env); a deterministic local provider is used for dev/tests, and retrieval can fall back to Postgres full-text search. This is recorded in ADR-006.
- Isolation: the retrieval function signature requires `organizationId`; there is no unscoped variant.
