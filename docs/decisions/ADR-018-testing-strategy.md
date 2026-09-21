# ADR-018: Testing strategy and coverage floors

**Status:** Accepted (Phase 11). Records what is tested at which level, what the CI gate enforces, and what is deliberately not measured.

## Context

By Phase 10 the project had roughly a thousand tests, but three things were unclear: how much of the code they actually reach, whether they could be trusted (some failed differently on every run), and what stops coverage from quietly eroding as features are added. Phase 11 measured, fixed the unreliable tests, filled the largest gaps, and turned the result into a gate.

## Decisions

1. **Four levels, each for what it is good at.**
   - _Unit tests_ (Vitest, no infrastructure): pure logic, schemas, parsers, formatting, and processors and components with their collaborators faked. Fast enough to run on every save.
   - _Integration tests_ (Vitest against real PostgreSQL and Redis): the API through Nest and Supertest, and the workers through real queues. These prove tenant isolation, permissions, transactions and idempotency, which a mock cannot. Most of the API's coverage comes from here.
   - _Component tests_ (Vitest, jsdom, Testing Library): forms and panels are tested as a user meets them: what is shown, what is sent, and what happens on failure. Only `*.test.tsx` files get a DOM; everything else stays in Node.
   - _End-to-end tests_ (Playwright): the full stack in a browser, for whole flows and for things only a browser can show (the CSP, live updates).
2. **Component tests do not re-test the server's rules.** A members panel test checks that an admin is not offered the OWNER role and that removal needs confirmation. Whether the API actually refuses is proven by the API's integration tests. Testing the same rule twice at two levels only makes changes more expensive.
3. **Coverage floors, enforced in CI, set just under measured values.** `pnpm test:coverage` runs every package's tests with coverage, and a package fails the build when it drops below its floor (in its `vitest.config.ts`). Measured with integration tests included:

   | Package           | Statements | Branches | Floor (statements / branches) |
   | ----------------- | ---------- | -------- | ----------------------------- |
   | `packages/shared` | 99.5%      | 93.8%    | 97 / 90                       |
   | `apps/api`        | 98.0%      | 90.5%    | 95 / 87                       |
   | `workers`         | 92.1%      | 89.5%    | 88 / 85                       |

   The floors exist to fail a change that adds untested code, not to chase a number. Raise them when coverage rises; never lower one to make a build pass without saying why in the commit.

4. **What is deliberately not gated.**
   - `apps/web` has no floor. Unit and component tests reach about a sixth of its statements, and the rest (pages, layouts, data-fetching views) is covered by Playwright, which does not produce comparable numbers. A floor on the small measurable part would be misleading.
   - `main.ts` in the API and the workers is excluded: it wires modules together and starts a process, and the Docker stack and end-to-end tests exercise it.
   - Coverage says which lines ran, not whether anything was checked. The security-relevant behaviour (tenant isolation, permission matrix, HTML safety of rendered documents, single-use reset tokens) has tests that assert the refusal, not just tests that run the code.
5. **Integration tests are deterministic or they are bugs.** Four sources of intermittent failure were found and fixed, and one source of pollution, and the rules are recorded here so they are not reintroduced:
   - _Shared queues._ Worker integration files share one PostgreSQL and one Redis, and several run real dispatchers and workers. A dispatcher claims every due check in the database, so files running in parallel stole each other's work. Worker test files now run one at a time (`fileParallelism: false`).
   - _Clocks._ The dispatcher compares against the database's clock, which runs in a container and can lag the test process by milliseconds. A test that needs "due now" sets the time a few seconds in the past instead of `new Date()`.
   - _A polluted development Redis._ Running tests against the same Redis as a running stack means the stack's worker consumes test jobs, and a stopped stack leaves a backlog that the test's job waits behind. Point tests at a separate Redis database (`REDIS_URL=redis://localhost:6379/1`) and, ideally, a separate PostgreSQL database. CI gets a fresh instance of each, so it is not affected.
   - _Timeouts tuned for an idle machine._ Testing Library waits 1 s for an element and a test gets 5 s, which is not enough when a form is typed into with user-event on a busy runner. Six copies of the web suite run at once failed every time until the waits were raised (5 s to find, 20 s per test) in the web test setup. A slow run must not look like a failure.
   - _Checks that outlive the test that made them._ A monitoring check is enabled by default and its organization cannot be deleted (the audit log is append-only), so every test-created check stayed scheduled forever. On one development database that reached 1,233 enabled checks for the dispatcher to enqueue and the worker to probe at addresses that no longer existed. A shared Vitest global setup (`scripts/vitest-disable-test-checks.mjs`, used by the api, workers and database packages) reads the database clock when a run starts and, when it ends, disables every check created since. It does nothing without `DATABASE_URL`. The catch: a check someone else creates on that database while a run is in progress is disabled too, so do not use the database at the same time. End-to-end (Playwright) runs are not covered; they run against a throwaway database in CI.
6. **A test title must say only what the test checks.** Two titles in this phase promised more than their bodies verified and were corrected. A name that over-claims is worse than a missing test, because it stops anyone looking for the gap.

## Known gaps

Recorded so they are a decision, not an oversight:

- Web components for automation rules and webhooks, the incident detail and list views, the AI investigation panel and the knowledge editor have no component tests yet; Playwright covers their main flows.
- In the workers, the automation and monitoring dispatchers' rarer error paths, the embedding job's fallbacks, and the small Redis and logger helpers are not fully covered.
- Load and soak testing, and mutation testing, were not done.

## Consequences

- A change that adds untested code to the API, the workers or the shared package fails CI with the package and the metric that dropped.
- The integration suite is slower (worker files run serially, about a minute and a half) in exchange for giving the same answer every time.
- Developers who run integration tests locally need to keep them away from a running development stack; the README says how.
