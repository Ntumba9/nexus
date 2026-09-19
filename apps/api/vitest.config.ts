import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The first test that boots a Nest testing module pays a one-off cold-start cost.
    testTimeout: 30_000,
    // Suites register several users in beforeAll, and password hashing is deliberately CPU-heavy.
    // With every integration file running in parallel on a small machine, the 10s default is not
    // enough and whole suites failed at setup (with all their tests skipped).
    hookTimeout: 60_000,
  },
});
