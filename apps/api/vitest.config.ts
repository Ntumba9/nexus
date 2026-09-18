import { defineConfig } from 'vitest/config';

export default defineConfig({
  // The first test that boots a Nest testing module pays a one-off cold-start cost.
  test: { testTimeout: 30_000 },
});
