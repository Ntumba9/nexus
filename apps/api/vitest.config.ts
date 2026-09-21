import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Switches off the monitoring checks the tests created, so they are not probed forever.
    globalSetup: ['../../scripts/vitest-disable-test-checks.mjs'],
    // The first test that boots a Nest testing module pays a one-off cold-start cost.
    testTimeout: 30_000,
    // Suites register several users in beforeAll, and password hashing is deliberately CPU-heavy.
    // With every integration file running in parallel on a small machine, the 10s default is not
    // enough and whole suites failed at setup (with all their tests skipped).
    hookTimeout: 60_000,
    coverage: {
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/main.ts'],
      // Measured with integration tests included (97.4% statements, 90.4% branches). A floor just
      // under that: it fails the build when new code arrives untested.
      thresholds: { statements: 95, lines: 95, functions: 95, branches: 87 },
    },
  },
});
