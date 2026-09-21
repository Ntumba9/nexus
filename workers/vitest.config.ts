import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Switches off the monitoring checks the tests created, so they are not probed forever.
    globalSetup: ['../scripts/vitest-disable-test-checks.mjs'],
    // Integration files share one PostgreSQL and one Redis. Several of them run real dispatchers and
    // workers on the real queues, and a dispatcher claims every due check in the database, so files
    // running in parallel steal each other's work and fail differently on every run. One file at a
    // time is slower but deterministic.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    coverage: {
      include: ['src/**/*.ts'],
      // main.ts only wires things together and runs a process; the Docker stack and the end-to-end
      // tests exercise it.
      exclude: ['src/**/*.test.ts', 'src/main.ts'],
      // Measured with integration tests included (about 93% without main.ts). A floor a little under.
      thresholds: { statements: 88, lines: 88, functions: 85, branches: 85 },
    },
  },
});
