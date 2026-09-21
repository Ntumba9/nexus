import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Switches off the monitoring checks the tests created, so they are not probed forever.
    globalSetup: ['../../scripts/vitest-disable-test-checks.mjs'],
  },
});
