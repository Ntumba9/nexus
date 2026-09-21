import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/index.ts'],
      // A floor just under today's numbers (99.5% statements, 93.8% branches): it exists to fail the
      // build when new code arrives untested, not to chase a number.
      thresholds: { statements: 97, lines: 97, functions: 95, branches: 90 },
    },
  },
});
